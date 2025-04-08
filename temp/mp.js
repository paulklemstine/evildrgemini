/**
 * Multiplayer Library using PeerJS
 *
 * Extracted from multiplayer.html and chat.html examples.
 * Provides core functionality for establishing P2P connections,
 * managing peers, and broadcasting/handling messages.
 *
 * Integration:
 * 1. Include this script in your HTML.
 * 2. Call `MPLib.initialize(...)` to start the connection process.
 * 3. Provide callback functions for handling events like connection open,
 * data received, peer joining/leaving, and errors.
 * 4. Use `MPLib.broadcast(...)` to send data to peers.
 * 5. Use `MPLib.sendDirect(...)` to send data to a specific peer.
 * 6. Access `MPLib.localPeerId` and `MPLib.connections` for state info.
 */
const MPLib = (() => {

    // --- Configuration & State ---
    let peer = null; // PeerJS instance
    let localPeerId = null; // Internal state variable
    let targetHostId = 'default-mp-channel'; // Default target host ID
    let isHost = false; // Internal state variable
    let hostPeerId = null; // Internal state variable - ID of the peer acting as host
    let isAttemptingHostId = false;
    const connections = new Map(); // Map<peerId, Peer.DataConnection>
    const pendingConnections = new Set(); // Peers we are trying to connect TO
    const seenMessageIds = new Set(); // For gossip protocol
    const MAX_SEEN_MESSAGES = 1000;
    let initialSyncComplete = false; // Flag to process initial sync only once
    let hostCheckTimeout = null; // Timeout for host connection attempt

    // Default configuration, override via initialize()
    let config = {
        targetHostId: targetHostId, // Allow overriding host ID via config
        debugLevel: 0, // PeerJS debug level (0-3)
        onStatusUpdate: (msg, type) => logMessage(msg, type), // Pass type along
        onError: (type, err) => logMessage(`Error (${type}): ${err?.message || err}`, 'error'),
        onPeerJoined: (peerId, conn) => logMessage(`Peer joined: ${peerId.slice(-6)}`, 'info'),
        onPeerLeft: (peerId) => logMessage(`Peer left: ${peerId.slice(-6)}`, 'info'),
        onDataReceived: (peerId, data) => logMessage(`Data from ${peerId.slice(-6)}: ${JSON.stringify(data)}`, 'info'),
        onConnectedToHost: (hostId) => logMessage(`Connected to host: ${hostId.slice(-6)}`, 'info'),
        onBecameHost: () => logMessage(`Became host!`, 'info'),
        onInitialSync: (syncData) => logMessage(`Received initial sync: ${JSON.stringify(syncData)}`, 'info'),
        getInitialSyncData: () => ({}), // Function for host to provide sync data
        maxConnections: 8, // Max simultaneous connections
        messageTTL: 4, // Max hops for gossip messages
        hostConnectionTimeoutMs: 7000, // How long to wait for host before assuming role
        forceClientOnly: false, // Option to prevent becoming host
    };

    // --- Utility Functions ---

    /** Generates a unique ID for messages */
    function generateUniqueId(prefix = 'msg') {
        return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }

    /** Logs messages to console and optionally to a UI element */
    function logMessage(message, type = 'info') {
        const logFunc = type === 'error' ? console.error : (type === 'warn' ? console.warn : console.log);
        logFunc(`[MPLib] ${message}`);
        // Allow application to handle UI logging via callback
        if (config.onStatusUpdate) {
            config.onStatusUpdate(`[MPLib] ${message}`, type); // Pass type to status update
        }
    }

    // --- Core PeerJS Functions ---

    /** Initializes the PeerJS connection */
    function initialize(options = {}) {
        if (peer && !peer.destroyed) {
            logMessage("Peer already initialized.", 'warn');
            return;
        }

        // Merge user options with defaults
        config = { ...config, ...options };
        targetHostId = config.targetHostId || targetHostId; // Use configured or default host ID

        logMessage(`Initializing PeerJS... Attempting host ID: ${targetHostId}`);
        config.onStatusUpdate(`Initializing network...`, 'info');
        isAttemptingHostId = true; // Flag that we are trying the host ID first
        initialSyncComplete = false; // Reset sync flag on initialization

        try {
            // Destroy previous instance if exists but is disconnected/closed
            if (peer) {
                try { peer.destroy(); } catch (e) { /* ignore */ }
                peer = null;
            }
            // Attempt to connect with the target host ID
            peer = new Peer(targetHostId, { debug: config.debugLevel });
            setupPeerListeners(peer);
        } catch (e) {
            logMessage(`Fatal PeerJS initialization error: ${e.message}`, 'error');
            config.onError('init', e);
            resetState(); // Reset state on fatal error
        }
    }

    /** Initializes PeerJS with a random ID (fallback) */
    function initializeAsClient() {
        logMessage("Host ID taken or unavailable. Initializing with random ID...");
        config.onStatusUpdate("Host ID taken. Getting random ID...", 'info');
        isAttemptingHostId = false; // No longer attempting the host ID

        try {
            // Ensure previous peer is destroyed before creating a new one
            if (peer && !peer.destroyed) {
                try { peer.destroy(); } catch (e) { /* ignore */ }
            }
            peer = null; // Clear reference
            // Create new peer with undefined ID (PeerJS generates one)
            peer = new Peer(undefined, { debug: config.debugLevel });
            setupPeerListeners(peer);
        } catch (e) {
            logMessage(`Fatal PeerJS client initialization error: ${e.message}`, 'error');
            config.onError('client_init', e);
            resetState(); // Reset state on fatal error
        }
    }

    /** Sets up the main PeerJS event handlers */
    function setupPeerListeners(currentPeer) {
        if (!currentPeer) return;

        // Clear any existing listeners if reusing peer object (though usually we create new)
        currentPeer.off('open');
        currentPeer.off('connection');
        currentPeer.off('disconnected');
        currentPeer.off('close');
        currentPeer.off('error');

        currentPeer.on('open', (id) => {
            if (!id) {
                logMessage("Error: Received null ID from PeerJS.", 'error');
                config.onError('null_id', 'PeerJS returned a null ID');
                // If the host ID attempt failed with null, try as client
                if (isAttemptingHostId) {
                    initializeAsClient();
                } else {
                    resetState(); // If client attempt also fails with null
                }
                return;
            }

            localPeerId = id; // <-- Assign to INTERNAL variable ONLY
            // MPLib.localPeerId = id; // <-- REMOVED THIS LINE
            logMessage(`PeerJS opened with ID: ${id}`, 'info');

            if (isAttemptingHostId && id === targetHostId) {
                // Successfully claimed the host ID
                becomeHost(); // Transition to host state
            } else {
                // Did not get the host ID (either it was taken or we initialized as client)
                isHost = false; // <-- Assign to INTERNAL variable ONLY
                // MPLib.isHost = false; // <-- REMOVED THIS LINE
                hostPeerId = targetHostId; // <-- Assign to INTERNAL variable ONLY. Assume target is host initially.
                // MPLib.hostPeerId = hostPeerId; // <-- REMOVED THIS LINE

                if (isAttemptingHostId) {
                    logMessage(`Host ID ${targetHostId} was taken. Now operating as client with ID ${id}.`, 'warn');
                } else {
                    logMessage(`Operating as client with ID ${id}.`, 'info');
                }
                config.onStatusUpdate(`Connected as ${id.slice(-6)}. Connecting to host ${targetHostId.slice(-6)}...`, 'info');
                connectToPeer(targetHostId); // Connect to the actual host

                // Set timeout to become host if connection fails (only if not forced client)
                if (!config.forceClientOnly) {
                    if (hostCheckTimeout) clearTimeout(hostCheckTimeout);
                    hostCheckTimeout = setTimeout(() => {
                        // Check if still not connected to host and not already host
                        if (!connections.has(targetHostId) && !isHost) {
                            logMessage("Host connection timed out. Assuming host role.", 'warn');
                            becomeHost(); // Fallback to hosting
                        }
                    }, config.hostConnectionTimeoutMs);
                }
            }
            // Status update handled inside becomeHost or connectToPeer response
        });

        currentPeer.on('connection', (conn) => {
            logMessage(`Incoming connection request from ${conn.peer.slice(-6)}`, 'info');
            handleIncomingConnection(conn);
        });

        currentPeer.on('disconnected', () => {
            logMessage("PeerJS disconnected from signaling server.", 'warn');
            config.onStatusUpdate("Server disconnected. Reconnecting...", 'warn');
            try {
                if (currentPeer && !currentPeer.destroyed) {
                    currentPeer.reconnect();
                }
            } catch (e) {
                logMessage(`Reconnect failed: ${e.message}`, 'error');
                config.onError('reconnect', e);
                // Don't necessarily reset state here, reconnect might succeed
            }
        });

        currentPeer.on('close', () => {
            logMessage("PeerJS connection closed permanently.", 'error');
            config.onError('close', 'Peer instance closed');
            resetState(); // Reset state on permanent closure
        });

        currentPeer.on('error', (err) => {
            logMessage(`PeerJS Error: ${err.type} - ${err.message}`, 'error');
            config.onError(err.type, err);

            // Handle specific errors
            if (err.type === 'unavailable-id' && isAttemptingHostId && err.message?.includes(targetHostId)) {
                // Host ID was taken, initialize as a client instead
                initializeAsClient();
            } else if (err.type === 'peer-unavailable') {
                const unavailablePeerId = err.message?.match(/Could not connect to peer\s(.*?)$/)?.[1];
                if (unavailablePeerId) {
                    logMessage(`Peer ${unavailablePeerId.slice(-6)} is unavailable.`, 'warn');
                    removeConnection(unavailablePeerId); // Clean up connection state
                    // If the host became unavailable, potentially try to become host
                    if (unavailablePeerId === hostPeerId && !isHost && !config.forceClientOnly) {
                        logMessage("Host unavailable. Assuming host role.", 'warn');
                        becomeHost();
                    }
                }
            } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(err.type)) {
                // Network or critical errors might require reset or different handling
                logMessage(`Critical PeerJS error (${err.type}). State may be inconsistent.`, 'error');
                // Consider reset for critical errors depending on desired robustness
                // resetState();
            }
        });
    }

    /** Handles incoming connection requests */
    function handleIncomingConnection(conn) {
        const remotePeerId = conn.peer;
        if (!remotePeerId) {
            logMessage("Incoming connection with no peer ID.", 'warn');
            try { conn.close(); } catch(e) {}
            return;
        }
        const existingConnData = connections.get(remotePeerId);
        const isPendingOutgoing = pendingConnections.has(remotePeerId);
        let keepIncoming = false;
        let closeExisting = false;
        let abandonOutgoing = false;

        // Tie-breaker logic: Lower Peer ID keeps their connection attempt
        if (existingConnData && existingConnData !== 'connecting' && existingConnData !== 'connecting-incoming') { // Already have an established connection
            if (localPeerId < remotePeerId) { // Our ID smaller, reject incoming
                logMessage(`[Tie-Breaker] My ID smaller than ${remotePeerId.slice(-6)}. Rejecting their incoming connection.`, 'info');
                rejectConnection(conn, 'Duplicate connection (tie-breaker)');
                return; // Keep our existing connection
            } else { // Our ID larger, close our existing connection, accept incoming
                logMessage(`[Tie-Breaker] My ID larger than ${remotePeerId.slice(-6)}. Replacing my existing connection with their incoming.`, 'info');
                closeExisting = true;
                keepIncoming = true;
            }
        } else if (isPendingOutgoing) { // We have a pending outgoing connection TO this peer
            if (localPeerId < remotePeerId) { // Our ID smaller, prefer our outgoing, reject incoming
                logMessage(`[Tie-Breaker] My ID smaller than ${remotePeerId.slice(-6)}. Rejecting their incoming, preferring my outgoing.`, 'info');
                rejectConnection(conn, 'Duplicate connection attempt (tie-breaker)');
                return; // Keep trying our outgoing connection
            } else { // Our ID larger, abandon our outgoing, accept incoming
                logMessage(`[Tie-Breaker] My ID larger than ${remotePeerId.slice(-6)}. Accepting their incoming, abandoning my outgoing.`, 'info');
                abandonOutgoing = true;
                keepIncoming = true;
            }
        } else { // No existing or pending connection
            keepIncoming = true;
        }


        // Final Decision & Setup
        if (keepIncoming) {
            // Check connection limits BEFORE accepting
            if (connections.size >= config.maxConnections && !closeExisting) {
                logMessage(`Max connections (${config.maxConnections}) reached. Rejecting ${remotePeerId.slice(-6)}`, 'warn');
                rejectConnection(conn, 'Room full');
                return;
            }

            // Clean up based on tie-breaker decision
            if (closeExisting && existingConnData && existingConnData !== 'connecting' && existingConnData !== 'connecting-incoming') {
                logMessage(`Closing existing connection object for ${remotePeerId.slice(-6)} before setup.`, 'info');
                try { existingConnData.close(); } catch (e) {}
                connections.delete(remotePeerId); // Ensure removal before setup adds new one
            }
            if (abandonOutgoing) {
                pendingConnections.delete(remotePeerId);
                if (connections.get(remotePeerId) === 'connecting') {
                    connections.delete(remotePeerId); // Remove placeholder if it existed
                }
                // Note: The actual outgoing Peer.DataConnection object is harder to cancel directly,
                // but setupConnection will replace the map entry, and errors/closures will eventually clean it up.
            }

            logMessage(`Proceeding to setup incoming connection with ${remotePeerId.slice(-6)}.`, 'info');
            // Add temporary placeholder before 'open' to prevent race conditions
            connections.set(remotePeerId, 'connecting-incoming');
            conn.on('open', () => {
                logMessage(`Incoming connection opened with ${remotePeerId.slice(-6)}`);
                // Final check for connection limit after open
                if (connections.size > config.maxConnections && connections.get(remotePeerId) !== conn) {
                    // Check if size EXCEEDS limit AND this specific conn isn't the one we intend to keep
                    logMessage(`Connection ${remotePeerId.slice(-6)} opened, but room now full OR connection replaced. Closing.`, 'warn');
                    try { conn.close(); } catch(e) {}
                    // Ensure placeholder is removed if closing immediately
                    if (connections.get(remotePeerId) === 'connecting-incoming') {
                        connections.delete(remotePeerId);
                    }
                    return;
                }
                // Check if we still intend to keep this incoming connection
                if (connections.get(remotePeerId) === 'connecting-incoming') {
                    setupConnection(conn); // Finalize setup
                } else {
                    logMessage(`Incoming connection ${remotePeerId.slice(-6)} opened, but state changed (likely lost tie-breaker). Closing.`, 'warn');
                    try { conn.close(); } catch(e) {}
                    // Ensure placeholder is removed if closing immediately
                    if (connections.get(remotePeerId) === 'connecting-incoming') {
                        connections.delete(remotePeerId);
                    }
                }
            });
            // Add temporary error/close handlers until 'open' fires
            conn.on('error', (err) => {
                logMessage(`Pre-open connection error with ${remotePeerId.slice(-6)}: ${err.type}`, 'error');
                removeConnection(remotePeerId); // Clean up map entry
            });
            conn.on('close', () => {
                logMessage(`Pre-open connection closed with ${remotePeerId.slice(-6)}`, 'warn');
                removeConnection(remotePeerId); // Clean up map entry
            });

        }
    }

    /** Rejects an incoming connection */
    function rejectConnection(conn, reason = 'Connection rejected') {
        conn.on('open', () => { // Wait for open to send rejection message
            try {
                conn.send({ type: 'system', payload: { type: 'rejected', message: reason } });
            } catch (e) { /* ignore send error on closed conn */ }
            setTimeout(() => {
                try { conn.close(); } catch (e) { /* ignore close error */ }
            }, 50); // Short delay before closing
        });
        conn.on('error', (err) => { }); // Ignore errors on rejected connections
        conn.on('close', () => { }); // Ignore close events on rejected connections
    }


    /** Finalizes setup for an established DataConnection */
    function setupConnection(conn) {
        const remotePeerId = conn.peer;
        if (!remotePeerId) return; // Should not happen

        // Replace 'connecting' placeholder or existing connection object
        connections.set(remotePeerId, conn);
        pendingConnections.delete(remotePeerId); // Remove from pending if it was an outgoing connection

        logMessage(`Connection setup complete with ${remotePeerId.slice(-6)}. Total: ${connections.size}`, 'info');
        config.onPeerJoined(remotePeerId, conn); // Notify application

        // If we are a client connecting to the host, trigger host connected callback
        if (!isHost && remotePeerId === hostPeerId) {
            config.onConnectedToHost(hostPeerId);
            // Clear host check timeout if we successfully connected
            if (hostCheckTimeout) {
                clearTimeout(hostCheckTimeout);
                hostCheckTimeout = null;
            }
        }

        // Send initial sync if we are the host
        if (isHost) {
            sendInitialSync(conn);
            // Inform other peers about the new arrival (gossip)
            // Use internal _broadcast to prevent messageId loopback issues
            _broadcast({ payload: { type: 'system', subType: 'peer_joined', peerId: remotePeerId } }, conn);
        }

        // --- Setup Data, Close, Error handlers ---
        conn.off('data'); // Remove previous handlers if any
        conn.off('close');
        conn.off('error');

        conn.on('data', (data) => {
            handleReceivedData(data, conn);
        });

        conn.on('close', () => {
            logMessage(`Connection closed with ${remotePeerId.slice(-6)}`, 'warn');
            removeConnection(remotePeerId);
            // Inform others about the departure (gossip)
            if (localPeerId) { // Only broadcast if we are still active
                _broadcast({ payload: { type: 'system', subType: 'peer_left', peerId: remotePeerId } });
            }
        });

        conn.on('error', (err) => {
            logMessage(`Connection error with ${remotePeerId.slice(-6)}: ${err.type}`, 'error');
            config.onError('connection', err);
            removeConnection(remotePeerId);
            // Optionally broadcast peer_left on error too, depending on desired behavior
            if (localPeerId) { // Only broadcast if we are still active
                _broadcast({ payload: { type: 'system', subType: 'peer_left', peerId: remotePeerId } });
            }
        });
    }

    /** Attempts to connect to a specific peer */
    function connectToPeer(targetPeerId) {
        if (!targetPeerId || targetPeerId === localPeerId || !peer || peer.destroyed) {
            if (targetPeerId === localPeerId) logMessage("Cannot connect to self.", 'warn');
            else logMessage(`Cannot connect: Invalid target (${targetPeerId}) or peer state (${peer?.destroyed}).`, 'warn');
            return;
        }
        // Allow re-attempting if previous attempt resulted in 'connecting' placeholder
        if (connections.has(targetPeerId) && connections.get(targetPeerId) !== 'connecting') {
            logMessage(`Already connected to ${targetPeerId.slice(-6)}`, 'info');
            return;
        }
        if (connections.size >= config.maxConnections) {
            logMessage(`Cannot connect to ${targetPeerId.slice(-6)}, max connections reached.`, 'warn');
            return;
        }

        logMessage(`Attempting outgoing connection to ${targetPeerId.slice(-6)}...`, 'info');
        config.onStatusUpdate(`Connecting ${targetPeerId.slice(-6)}...`, 'info');
        pendingConnections.add(targetPeerId); // Mark as pending
        connections.set(targetPeerId, 'connecting'); // Placeholder

        try {
            const conn = peer.connect(targetPeerId, { reliable: true });

            conn.on('open', () => {
                logMessage(`Outgoing connection opened with ${targetPeerId.slice(-6)}.`);
                // Connection opened successfully
                // Check if our placeholder is still 'connecting' (meaning we won/kept this outgoing attempt)
                if (connections.get(targetPeerId) === 'connecting') {
                    setupConnection(conn);
                } else {
                    // If state changed (e.g., incoming won), close this outgoing one
                    logMessage(`Outgoing to ${targetPeerId.slice(-6)} opened, but state changed (likely lost tie-breaker). Closing.`, 'warn');
                    try { conn.close(); } catch (e) {}
                    // Placeholder might have been replaced or deleted, no need to delete again here
                    pendingConnections.delete(targetPeerId); // Ensure removed from pending set
                }
            });

            conn.on('error', (err) => {
                logMessage(`Failed to connect to ${targetPeerId.slice(-6)}: ${err.type}`, 'error');
                config.onError('connect_error', err);
                // Clean up placeholder only if it's still 'connecting'
                if (connections.get(targetPeerId) === 'connecting') {
                    connections.delete(targetPeerId);
                }
                pendingConnections.delete(targetPeerId);
                // If connection to target host failed, maybe try becoming host
                if (targetPeerId === targetHostId && !isHost && !config.forceClientOnly) {
                    // Check if we *still* don't have a host connection after failure
                    if (!connections.has(targetHostId)) {
                        logMessage("Failed connection to host. Assuming host role.", 'warn');
                        becomeHost();
                    }
                }
            });
            conn.on('close', () => {
                logMessage(`Outgoing connection attempt to ${targetPeerId.slice(-6)} closed before open.`, 'warn');
                // Clean up placeholder only if it's still 'connecting'
                if (connections.get(targetPeerId) === 'connecting') {
                    connections.delete(targetPeerId);
                }
                pendingConnections.delete(targetPeerId);
                // If connection to target host failed, maybe try becoming host (check again)
                if (targetPeerId === targetHostId && !isHost && !config.forceClientOnly) {
                    if (!connections.has(targetHostId)) {
                        logMessage("Host connection attempt closed. Assuming host role.", 'warn');
                        becomeHost();
                    }
                }
            });

        } catch (e) {
            logMessage(`Error initiating connection to ${targetPeerId.slice(-6)}: ${e.message}`, 'error');
            config.onError('connect_init', e);
            if (connections.get(targetPeerId) === 'connecting') connections.delete(targetPeerId);
            pendingConnections.delete(targetPeerId);
        }
    }

    /** Removes a connection and notifies the application */
    function removeConnection(peerIdToRemove) {
        if (!peerIdToRemove) return;

        pendingConnections.delete(peerIdToRemove); // Remove from pending set if present

        const conn = connections.get(peerIdToRemove);
        if (conn) {
            connections.delete(peerIdToRemove); // Remove from map
            logMessage(`Removed connection entry for ${peerIdToRemove.slice(-6)}. Total: ${connections.size}`, 'info');
            config.onPeerLeft(peerIdToRemove); // Notify application

            // Close the connection object if it exists and is open
            if (conn !== 'connecting' && conn !== 'connecting-incoming' && typeof conn === 'object' && conn.open) {
                logMessage(`Closing connection object for ${peerIdToRemove.slice(-6)}`, 'info');
                try { conn.close(); } catch (e) { /* ignore */ }
            }

            // Check if host was lost
            if (peerIdToRemove === hostPeerId && !isHost) {
                logMessage("Lost connection to host!", 'warn');
                config.onError('host_disconnect', 'Lost connection to host');
                hostPeerId = null; // Clear host ID
                // MPLib.hostPeerId = null; // NO direct assignment
                // Attempt to connect to the default host ID again? Or become host?
                if (!config.forceClientOnly) {
                    logMessage("Attempting to reconnect to default host or assume host role.", 'warn');
                    connectToPeer(targetHostId); // Try default host again
                    // Set timeout to become host if re-connection fails
                    if (hostCheckTimeout) clearTimeout(hostCheckTimeout);
                    hostCheckTimeout = setTimeout(() => {
                        if (!connections.has(targetHostId) && !isHost) {
                            logMessage("Host reconnect timed out. Assuming host role.", 'warn');
                            becomeHost();
                        }
                    }, config.hostConnectionTimeoutMs);
                } else {
                    logMessage("Host disconnected and forceClientOnly is true. Waiting.", 'warn');
                    config.onStatusUpdate("Host disconnected. Waiting for new host...", 'warn');
                }
            }
        }
    }

    /** Sends initial game state to a new peer (Host Only) */
    function sendInitialSync(conn) {
        if (!isHost || !conn || !conn.open) return;
        const remotePeerId = conn.peer;
        logMessage(`Sending initial sync data to ${remotePeerId.slice(-6)}`, 'info');

        // Call app callback to get game-specific state
        const appSyncData = config.getInitialSyncData();

        const syncDataPayload = {
            ...appSyncData, // Include app-specific data first
            // Add core MPLib state
            peers: [localPeerId, ...Array.from(connections.keys())]
                .filter(id => id && id !== remotePeerId && connections.get(id) !== 'connecting' && connections.get(id) !== 'connecting-incoming') // Exclude recipient and pending
        };

        const syncMessage = {
            type: 'initialSync', // Wrapper type for direct message
            payload: syncDataPayload
        };

        try {
            conn.send(syncMessage);
        } catch (e) {
            logMessage(`Error sending initial sync to ${remotePeerId.slice(-6)}: ${e.message}`, 'error');
            removeConnection(remotePeerId); // Assume connection failed
        }
    }

    /** Handles received data, parses message, calls app callback */
    function handleReceivedData(data, sourceConn) {
        let payload, msgId, senderId, ttl, msgType, originalSenderId;
        const sourcePeerId = sourceConn?.peer;
        if (!sourcePeerId) return; // Ignore data from unknown source

        try {
            // --- Handle Direct Messages (like initialSync or explicit direct sends) ---
            if (data && data.type === 'initialSync' && data.payload) {
                payload = data.payload;
                senderId = sourcePeerId; // Sender is the direct connection
                logMessage(`Received initial sync from host ${senderId.slice(-6)}`, 'info');
                if (!initialSyncComplete) { // Process sync only once
                    initialSyncComplete = true;
                    isHost = false; // We received sync, so we are not the host
                    // MPLib.isHost = false; // NO direct assignment
                    hostPeerId = senderId; // The sender of initialSync is the host
                    // MPLib.hostPeerId = hostPeerId; // NO direct assignment

                    config.onInitialSync(payload); // Pass FULL payload (app data + peers) to app
                    config.onConnectedToHost(hostPeerId); // Also trigger connected to host callback

                    // Connect to peers mentioned in sync
                    payload.peers?.forEach(pid => {
                        if (pid && pid !== localPeerId && !connections.has(pid) && !pendingConnections.has(pid)) {
                            connectToPeer(pid);
                        }
                    });

                    // Clear host check timeout if we successfully synced
                    if (hostCheckTimeout) {
                        clearTimeout(hostCheckTimeout);
                        hostCheckTimeout = null;
                    }
                }
                return; // Don't process sync as gossip
            }

            // --- Handle System Messages (peer join/leave notifications, rejections etc) ---
            if (data && data.type === 'system' && data.payload) {
                payload = data.payload;
                senderId = sourcePeerId; // Sender is the direct connection
                logMessage(`Received system message from ${senderId.slice(-6)}: ${payload.type}`, 'info');
                switch(payload.type) {
                    case 'rejected':
                        logMessage(`Connection rejected by ${senderId.slice(-6)}: ${payload.message}`, 'warn');
                        config.onError('rejected', { peer: senderId, message: payload.message });
                        removeConnection(senderId); // Remove the connection that rejected us
                        break;
                    // Other system messages can be handled here if needed
                }
                return; // Don't process system messages as gossip or app data
            }


            // --- Handle Standard Gossip Messages ---
            if (data && data.payload && data.messageId && data.originalSenderId && data.ttl !== undefined) {
                msgId = data.messageId;
                originalSenderId = data.originalSenderId; // Use original sender for app logic
                payload = data.payload; // The actual application data
                ttl = data.ttl;

                // Ignore own messages or already seen messages
                if (seenMessageIds.has(msgId)) return;
                if (originalSenderId === localPeerId) return; // Don't process our own forwarded messages

                seenMessageIds.add(msgId);
                if (seenMessageIds.size > MAX_SEEN_MESSAGES) {
                    // Simple cleanup: remove oldest half when limit exceeded
                    const oldestIds = Array.from(seenMessageIds).slice(0, Math.floor(MAX_SEEN_MESSAGES / 2));
                    oldestIds.forEach(id => seenMessageIds.delete(id));
                    logMessage(`Cleaned up ${oldestIds.length} old message IDs.`, 'debug');
                }

                // Process INTERNAL system messages carried over gossip (peer join/leave)
                if (payload.type === 'system' && payload.subType) {
                    switch(payload.subType) {
                        case 'peer_joined':
                            if (payload.peerId && payload.peerId !== localPeerId && !connections.has(payload.peerId) && !pendingConnections.has(payload.peerId)) {
                                logMessage(`Learned about new peer ${payload.peerId.slice(-6)} via gossip. Connecting...`, 'info');
                                connectToPeer(payload.peerId);
                            }
                            break;
                        case 'peer_left':
                            if (payload.peerId && payload.peerId !== localPeerId && connections.has(payload.peerId)) {
                                logMessage(`Learned about peer ${payload.peerId.slice(-6)} leaving via gossip. Removing connection.`, 'info');
                                removeConnection(payload.peerId);
                            }
                            break;
                    }
                }
                // Process application data via callback
                else {
                    // Ensure payload is the app data, not the system wrapper
                    config.onDataReceived(originalSenderId, payload);
                }

                // Forward the message if TTL allows
                if (ttl > 0 && connections.size > 1) {
                    _broadcast(data, sourceConn, ttl - 1); // Pass original data, decrement TTL
                }

            }
            // --- Handle Direct Application Messages (Sent via sendDirect) ---
            else if (data && !data.messageId && typeof data === 'object') { // Check if it's an object but not a gossip message
                logMessage(`Received direct message from ${sourcePeerId.slice(-6)}`, 'info');
                config.onDataReceived(sourcePeerId, data); // Pass directly to application
            }
            else {
                logMessage(`Received unknown/malformed data from ${sourcePeerId.slice(-6)}: ${JSON.stringify(data)}`, 'warn');
            }
        } catch (e) {
            logMessage(`Error processing data from ${sourcePeerId.slice(-6)}: ${e.message} - Data: ${JSON.stringify(data)}`, 'error');
        }
    }

    /** Internal broadcast function for gossip protocol */
    function _broadcast(messageData, receivedFromConn = null, currentTtl = undefined) {
        if (!localPeerId || connections.size === 0) return; // Can't broadcast without ID or connections

        let dataToSend = messageData;

        // If this is the first broadcast (not a forward), add gossip headers
        if (currentTtl === undefined) {
            // Ensure the payload isn't empty or null before wrapping
            if (!messageData.payload) {
                logMessage("Cannot broadcast empty payload.", 'warn');
                return;
            }
            dataToSend = {
                payload: messageData.payload, // The actual app data
                messageId: generateUniqueId(),
                originalSenderId: localPeerId,
                ttl: config.messageTTL,
            };
            // Add own message ID immediately to prevent processing loopback if somehow received
            seenMessageIds.add(dataToSend.messageId);
        } else {
            // If forwarding, just update TTL
            dataToSend.ttl = currentTtl;
        }


        // console.log(`Broadcasting msg ${dataToSend.messageId?.slice(0,8)} (TTL: ${dataToSend.ttl}) from ${dataToSend.originalSenderId.slice(-6)}`);

        connections.forEach((conn, peerId) => {
            // Don't send back to the peer we just received from
            if (receivedFromConn && conn === receivedFromConn) return;

            if (conn && conn !== 'connecting' && conn !== 'connecting-incoming' && conn.open) {
                try {
                    conn.send(dataToSend);
                } catch (e) {
                    logMessage(`Error broadcasting to ${peerId.slice(-6)}: ${e.message}`, 'error');
                    removeConnection(peerId); // Assume connection failed
                }
            }
        });
    }

    /** Function for host transition */
    function becomeHost() {
        if (isHost) return; // Already host
        isHost = true; // <-- Assign to INTERNAL variable ONLY
        // MPLib.isHost = true; // <-- REMOVED THIS LINE
        hostPeerId = localPeerId; // <-- Assign to INTERNAL variable ONLY
        // MPLib.hostPeerId = hostPeerId; // <-- REMOVED THIS LINE
        initialSyncComplete = true; // Host is always considered synced
        if (hostCheckTimeout) clearTimeout(hostCheckTimeout); // Clear any pending timeout
        hostCheckTimeout = null;
        logMessage("Assumed host role.", 'info');
        config.onBecameHost();
        config.onStatusUpdate(`Hosting as ${localPeerId.slice(-6)}`, 'info');
        // Host should initialize game state if needed (application responsibility)
        // config.getInitialSyncData(); // Maybe call this to trigger state init?
    }

    /** Disconnects from all peers and signaling server */
    function disconnect() {
        logMessage("Disconnecting from network...", 'info');
        if (peer && !peer.destroyed) {
            try {
                peer.destroy(); // Destroys peer object, closes connections
            } catch (e) {
                logMessage(`Error destroying peer: ${e.message}`, 'error');
            }
        }
        resetState(); // Clean up internal state
    }


    /** Resets the library state */
    function resetState() {
        logMessage("Resetting multiplayer library state.", 'warn');
        // Don't destroy peer here, let disconnect handle it or let PeerJS errors handle closure
        // if (peer && !peer.destroyed) { try { peer.destroy(); } catch (e) {} }
        peer = null;
        localPeerId = null;
        // MPLib.localPeerId = null; // No direct assignment
        isHost = false;
        // MPLib.isHost = false; // No direct assignment
        hostPeerId = null;
        // MPLib.hostPeerId = null; // No direct assignment
        isAttemptingHostId = false;
        initialSyncComplete = false;
        connections.clear();
        pendingConnections.clear();
        seenMessageIds.clear();
        if (hostCheckTimeout) clearTimeout(hostCheckTimeout);
        hostCheckTimeout = null;
        config.onStatusUpdate("Disconnected.", 'info');
    }

    // --- Public API ---
    // These methods are exposed on the MPLib object
    const publicApi = {
        initialize,
        disconnect, // Add disconnect method
        // Public broadcast: wraps payload in gossip headers
        broadcast: (payload) => {
            if (!payload) {
                logMessage("Broadcast payload cannot be empty.", 'warn');
                return;
            }
            // Ensure payload isn't accidentally a system message
            if (typeof payload === 'object' && payload.type === 'system') {
                logMessage("Attempted to broadcast a system message via public broadcast. Use internal methods.", 'error');
                return;
            }
            _broadcast({ payload }); // Use internal broadcast to add headers
        },
        // Send directly to one peer (no gossip)
        sendDirect: (targetPeerId, payload) => {
            if (!targetPeerId || !payload) {
                logMessage("Direct send requires targetPeerId and payload.", 'warn');
                return;
            }
            const conn = connections.get(targetPeerId);
            if (conn && conn !== 'connecting' && conn !== 'connecting-incoming' && conn.open) {
                try {
                    conn.send(payload); // Send payload directly
                } catch (e) {
                    logMessage(`Error sending direct message to ${targetPeerId.slice(-6)}: ${e.message}`, 'error');
                    removeConnection(targetPeerId); // Assume connection failed
                }
            } else {
                logMessage(`No open connection to ${targetPeerId.slice(-6)} for direct message.`, 'warn');
            }
        },
        getConnections: () => new Map(connections), // Return a copy of the connections map
        getLocalPeerId: () => localPeerId, // Use internal variable directly for getter method
        isHost: () => isHost,             // Use internal variable directly for getter method
        getHostPeerId: () => hostPeerId,     // Use internal variable directly for getter method
        // Expose state directly via properties for read-only access using getters
        get peerInstance() { return peer; }, // Access peer object if needed (use cautiously)
    };

    // Define getters for reactive properties that expose the internal state variables
    Object.defineProperty(publicApi, 'localPeerId', { get: () => localPeerId, enumerable: true, configurable: true });
    Object.defineProperty(publicApi, 'connections', { get: () => connections, enumerable: true, configurable: true }); // Provides direct map access
    Object.defineProperty(publicApi, 'hostPeerId', { get: () => hostPeerId, enumerable: true, configurable: true });
    Object.defineProperty(publicApi, 'isHost', { get: () => isHost, enumerable: true, configurable: true });


    return publicApi;

})();

// Make MPLib globally available (if not using modules)
// window.MPLib = MPLib;

// --- Add export for ES6 Module usage ---
export default MPLib;