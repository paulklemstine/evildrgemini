/**
 * Multiplayer Library using PeerJS for a Full Mesh Network
 *
 * Connects every peer to every other peer directly.
 * Provides functionality for establishing P2P connections,
 * managing peers, broadcasting/handling messages, and peer discovery.
 *
 * Integration:
 * 1. Include this script in your HTML.
 * 2. Call `MPLib.initialize(...)` to start the connection process.
 * 3. Provide callback functions for handling events like connection open,
 * data received, peer joining/leaving, and errors.
 * 4. Use `MPLib.broadcast(...)` to send data to all connected peers.
 * 5. Use `MPLib.sendDirect(...)` to send data to a specific peer.
 * 6. Access `MPLib.localPeerId` and `MPLib.connections` for state info.
 */
const MPLib = (() => {

    // --- Configuration & State ---
    let peer = null; // PeerJS instance
    let localPeerId = null;
    let knownPeers = new Set(); // Set of all known peer IDs (including self)
    const connections = new Map(); // Map<peerId, Peer.DataConnection> - Active connections
    const pendingConnections = new Set(); // Peer IDs we are actively trying to connect TO
    const seenMessageIds = new Set(); // For message de-duplication
    const MAX_SEEN_MESSAGES = 1000;
    const MAX_CONNECTIONS = 16; // Adjust max connections for mesh
    const DISCOVERY_INTERVAL_MS = 10000; // Interval to broadcast known peers for discovery
    const RECONNECT_ATTEMPT_DELAY_MS = 5000; // Delay before attempting reconnect
    let discoveryInterval = null;
    let reconnectTimeout = null;


    let config = { // Default configuration, override via initialize()
        debugLevel: 0, // PeerJS debug level (0-3)
        peerIdPrefix: 'geems-peer-', // Optional prefix for generated IDs
        onStatusUpdate: (msg) => logMessage(msg, 'info'),
        onError: (type, err) => logMessage(`Error (${type}): ${err?.message || err}`, 'error'),
        onPeerJoined: (peerId, conn) => logMessage(`Peer joined: ${peerId.slice(-6)}`, 'info'),
        onPeerLeft: (peerId) => logMessage(`Peer left: ${peerId.slice(-6)}`, 'info'),
        onDataReceived: (peerId, data) => logMessage(`Data from ${peerId.slice(-6)}: ${JSON.stringify(data)}`, 'info'),
        onNetworkReady: (peerId) => logMessage(`Network ready. Your ID: ${peerId.slice(-6)}`, 'info'), // Called when PeerJS is open
        getInitialSyncData: () => ({}), // Function for app to provide initial state data (optional)
        onInitialSync: (syncData) => logMessage(`Received initial app sync: ${JSON.stringify(syncData)}`, 'info'), // Callback for receiving initial app sync data
        maxConnections: MAX_CONNECTIONS,
    };

    // --- Utility Functions ---

    /** Generates a unique ID for messages */
    function generateUniqueId(prefix = 'msg') {
        return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }

    /** Simple hash function for string IDs */
    function simpleHash(str) {
        if (!str) return 0;
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32bit integer
        }
        return Math.abs(hash);
    }

    /** Generates a color based on a peer ID */
    function getColorForPeerId(peerId) {
        const hash = simpleHash(peerId);
        const hue = (hash % 360);
        return `hsl(${hue}, 75%, 60%)`;
    }

    /** Logs messages to console and optionally to a UI element */
    function logMessage(message, type = 'info') {
        console[type === 'error' ? 'error' : (type === 'warn' ? 'warn' : 'log')](`[MPLib] ${message}`);
        // Optional UI logging (if element exists)
        const logOutput = document.getElementById('mp-log-output'); // Assuming an ID for logging
        if (logOutput) {
            const div = document.createElement('div');
            div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
            div.className = `log-message log-${type}`;
            logOutput.insertBefore(div, logOutput.firstChild);
            if (logOutput.children.length > 50) { // Limit log lines
                logOutput.removeChild(logOutput.lastChild);
            }
        }
        // Update general status via callback
        if (type === 'info' || type === 'warn' || type === 'status') {
            config.onStatusUpdate(message);
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
        config = {...config, ...options};

        resetState(); // Ensure clean state before initializing

        logMessage(`Initializing PeerJS with prefix '${config.peerIdPrefix}'...`);
        config.onStatusUpdate(`Initializing network...`);

        try {
            // Create new peer with a prefixed generated ID
            const peerJsId = config.peerIdPrefix + generateUniqueId('id');
            peer = new Peer(peerJsId, {debug: config.debugLevel});
            setupPeerListeners(peer);
        } catch (e) {
            logMessage(`Fatal PeerJS initialization error: ${e.message}`, 'error');
            config.onError('init', e);
            resetState();
        }
    }


    /** Sets up the main PeerJS event handlers */
    function setupPeerListeners(currentPeer) {
        if (!currentPeer) return;

        currentPeer.on('open', (id) => {
            if (!id) {
                logMessage("Error: Received null ID from PeerJS.", 'error');
                config.onError('null_id', 'PeerJS returned a null ID');
                scheduleReconnect(); // Try again after a delay
                return;
            }
            if (reconnectTimeout) { // Clear any pending reconnect attempts on success
                clearTimeout(reconnectTimeout);
                reconnectTimeout = null;
            }

            localPeerId = id;
            MPLib.localPeerId = id; // Expose local ID
            knownPeers.add(localPeerId); // Add self to known peers
            logMessage(`PeerJS connection open. Your ID: ${id}`, 'info');
            config.onNetworkReady(id); // Notify app that network layer is ready
            config.onStatusUpdate(`Online as ${id.slice(-6)}. Discovering peers...`);

            // Start discovery process (periodically broadcast known peers)
            startDiscovery();

            // Attempt to connect to any peers already known (e.g., from previous session if implemented)
            connectToKnownPeers();
        });

        currentPeer.on('connection', (conn) => {
            logMessage(`Incoming connection request from ${conn.peer}`, 'info');
            handleIncomingConnection(conn);
        });

        currentPeer.on('disconnected', () => {
            logMessage("PeerJS disconnected from signaling server.", 'warn');
            config.onStatusUpdate("Server disconnected. Attempting to reconnect...");
            // PeerJS attempts reconnection automatically, but we might schedule our own check
            if (!reconnectTimeout) { // Avoid scheduling multiple reconnects
                scheduleReconnect();
            }
        });

        currentPeer.on('close', () => {
            logMessage("PeerJS connection closed permanently.", 'error');
            config.onError('close', 'Peer instance closed');
            resetState(); // Full reset required
        });

        currentPeer.on('error', (err) => {
            logMessage(`PeerJS Error: ${err.type} - ${err.message}`, 'error');
            config.onError(err.type, err);

            // Handle specific errors
            if (err.type === 'peer-unavailable') {
                const unavailablePeerId = err.message?.match(/peer\s(.*?)\s/)?.[1];
                if (unavailablePeerId) {
                    logMessage(`Peer ${unavailablePeerId.slice(-6)} unavailable. Removing connection.`, 'warn');
                    removeConnection(unavailablePeerId);
                }
            } else if (['network', 'server-error', 'socket-error', 'disconnected'].includes(err.type)) {
                logMessage("Network/Server error detected. Attempting reconnect sequence.", 'warn');
                if (!reconnectTimeout) { // Avoid scheduling multiple reconnects
                    scheduleReconnect();
                }
            } else if (err.type === 'webrtc') {
                logMessage("WebRTC connection error. This might affect specific peer connections.", 'warn');
                // We might not need a full reconnect here, connection-specific errors are handled
            } else if (err.type === 'unavailable-id') {
                logMessage("Peer ID conflict or issue. Re-initializing.", 'error');
                resetAndInitialize(); // Full re-init needed
            }
        });
    }

    /** Schedules a reconnect attempt after a delay */
    function scheduleReconnect() {
        if (reconnectTimeout) clearTimeout(reconnectTimeout); // Clear existing timer
        logMessage(`Scheduling reconnect attempt in ${RECONNECT_ATTEMPT_DELAY_MS / 1000} seconds...`);
        reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null; // Clear the timeout ID
            if (peer && !peer.destroyed && !peer.disconnected) {
                logMessage("Already reconnected or connection is stable. Aborting scheduled reconnect.", "info");
                return;
            }
            logMessage("Attempting to reconnect PeerJS...", "warn");
            try {
                if (peer && !peer.destroyed) {
                    peer.reconnect();
                } else {
                    logMessage("Peer was destroyed. Re-initializing.", "warn");
                    resetAndInitialize();
                }
            } catch(e) {
                logMessage(`Reconnect/Re-initialize failed: ${e.message}`, "error");
                config.onError('reconnect_attempt', e);
                // Consider a more robust backoff strategy if needed
                scheduleReconnect(); // Schedule another attempt
            }
        }, RECONNECT_ATTEMPT_DELAY_MS);
    }

    /** Helper to reset state and re-initialize */
    function resetAndInitialize() {
        resetState();
        setTimeout(() => initialize(config), 100); // Re-initialize after a short delay
    }


    /** Handles incoming connection requests */
    function handleIncomingConnection(conn) {
        const remotePeerId = conn.peer;
        if (!remotePeerId) {
            logMessage("Incoming connection with no peer ID.", 'warn');
            try { conn.close(); } catch(e) {}
            return;
        }

        logMessage(`Handling incoming connection from ${remotePeerId.slice(-6)}`, 'info');

        // Check if already connected or pending
        if (connections.has(remotePeerId)) {
            logMessage(`Already connected/connecting to ${remotePeerId.slice(-6)}. Ignoring incoming.`, 'info');
            // Don't reject, PeerJS handles duplicate connection attempts gracefully typically.
            // If issues arise, might need logic to prioritize one connection (e.g., based on ID comparison).
            return;
        }
        // Check connection limits BEFORE accepting
        if (connections.size >= config.maxConnections) {
            logMessage(`Max connections (${config.maxConnections}) reached. Rejecting ${remotePeerId.slice(-6)}`, 'warn');
            rejectConnection(conn, 'Network full'); // Explicitly reject
            return;
        }


        // Add temporary handlers before 'open'
        conn.on('error', (err) => {
            logMessage(`Pre-open connection error with ${remotePeerId.slice(-6)}: ${err.type}`, 'error');
            removeConnection(remotePeerId); // Clean up if error before open
        });
        conn.on('close', () => {
            logMessage(`Pre-open connection closed with ${remotePeerId.slice(-6)}`, 'warn');
            removeConnection(remotePeerId); // Clean up if closed before open
        });

        conn.on('open', () => {
            // Final check for limits *after* connection opens, in case limit was reached concurrently
            if (connections.size >= config.maxConnections && !connections.has(remotePeerId)) {
                logMessage(`Connection ${remotePeerId.slice(-6)} opened, but network now full. Closing.`, 'warn');
                try { conn.close(); } catch(e) {}
                removeConnection(remotePeerId); // Ensure cleanup
                return;
            }

            logMessage(`Connection opened with ${remotePeerId.slice(-6)}. Setting up...`);
            setupConnection(conn); // Finalize setup now that it's open
        });

        // Accept the connection (PeerJS handles this implicitly by attaching handlers)
        logMessage(`Accepted incoming connection from ${remotePeerId.slice(-6)}. Waiting for 'open'.`, 'info');
        // Store temporarily to avoid race conditions if outgoing is initiated simultaneously
        // connections.set(remotePeerId, 'accepting'); // Tentative state
    }

    /** Rejects an incoming connection */
    function rejectConnection(conn, reason = 'Connection rejected') {
        conn.on('open', () => { // Wait for open to send rejection message
            try {
                conn.send({ type: '_mp_internal', payload: { type: 'reject', reason: reason } });
            } catch (e) { /* ignore send error */ }
            setTimeout(() => {
                try { conn.close(); } catch (e) { /* ignore close error */ }
            }, 100); // Short delay to allow message sending
        });
        conn.on('error', (err) => { /* Ignore errors on rejected connections */ });
    }

    /** Finalizes setup for an established DataConnection */
    function setupConnection(conn) {
        const remotePeerId = conn.peer;
        if (!remotePeerId || connections.get(remotePeerId) === conn) {
            // logMessage(`Connection with ${remotePeerId?.slice(-6)} already fully set up.`, 'debug');
            return; // Already setup or invalid peer ID
        }

        // --- Replace existing connection/placeholder ---
        const existingState = connections.get(remotePeerId);
        if (existingState && existingState !== 'connecting' && existingState !== 'accepting') {
            logMessage(`Replacing existing connection object for ${remotePeerId.slice(-6)}`, 'warn');
            try { existingState.close(); } catch(e) {} // Close old connection object
        }

        connections.set(remotePeerId, conn); // Store the established connection
        pendingConnections.delete(remotePeerId); // Remove from pending list if it was outgoing
        knownPeers.add(remotePeerId); // Add to known peers

        logMessage(`Connection setup complete with ${remotePeerId.slice(-6)}. Total connected: ${connections.size}`, 'info');
        config.onPeerJoined(remotePeerId, conn); // Notify application

        // --- Send initial data ---
        // 1. Send our list of known peers (excluding the recipient)
        sendPeerList(conn);
        // 2. Send initial application sync data (if provided by app)
        sendInitialAppSync(conn);


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
        });

        conn.on('error', (err) => {
            logMessage(`Connection error with ${remotePeerId.slice(-6)}: ${err.type}`, 'error');
            config.onError('connection', err);
            removeConnection(remotePeerId);
        });
    }

    /** Attempts to connect to a specific peer */
    function connectToPeer(targetPeerId) {
        if (!targetPeerId || targetPeerId === localPeerId || !peer || peer.destroyed) return;
        if (connections.has(targetPeerId) || pendingConnections.has(targetPeerId)) {
            // logMessage(`Already connected or connecting to ${targetPeerId.slice(-6)}.`, 'debug');
            return;
        }
        if (connections.size >= config.maxConnections) {
            logMessage(`Cannot connect to ${targetPeerId.slice(-6)}, max connections reached.`, 'warn');
            return;
        }

        logMessage(`Attempting outgoing connection to ${targetPeerId.slice(-6)}...`, 'info');
        config.onStatusUpdate(`Connecting ${targetPeerId.slice(-6)}...`);
        pendingConnections.add(targetPeerId); // Mark as pending
        // connections.set(targetPeerId, 'connecting'); // Placeholder - Optional

        try {
            const conn = peer.connect(targetPeerId, { reliable: true }); // Or adjust reliability as needed

            conn.on('open', () => {
                logMessage(`Outgoing connection to ${targetPeerId.slice(-6)} opened.`, 'info');
                // Check if an incoming connection from the same peer was accepted while this was opening
                const existingConn = connections.get(targetPeerId);
                if(existingConn && existingConn !== conn) {
                    logMessage(`Incoming connection from ${targetPeerId.slice(-6)} established first. Closing this outgoing attempt.`, 'info');
                    try { conn.close(); } catch(e) {}
                    pendingConnections.delete(targetPeerId); // Clean up pending state
                } else {
                    // This outgoing connection is the primary one, set it up.
                    setupConnection(conn);
                }
            });

            conn.on('error', (err) => {
                logMessage(`Failed to connect to ${targetPeerId.slice(-6)}: ${err.type}`, 'error');
                config.onError('connect_error', {peerId: targetPeerId, error: err});
                pendingConnections.delete(targetPeerId);
                // connections.delete(targetPeerId); // Remove placeholder if used
                knownPeers.delete(targetPeerId); // Assume peer is gone if connection fails
            });

            conn.on('close', () => {
                logMessage(`Outgoing connection attempt to ${targetPeerId.slice(-6)} closed before open or during setup.`, 'warn');
                // Only remove from pending/connections if it wasn't fully set up
                if (pendingConnections.has(targetPeerId) || connections.get(targetPeerId) === 'connecting') {
                    pendingConnections.delete(targetPeerId);
                    connections.delete(targetPeerId);
                }
                // Do not remove from knownPeers here, let discovery handle it
            });

        } catch (e) {
            logMessage(`Error initiating connection to ${targetPeerId.slice(-6)}: ${e.message}`, 'error');
            config.onError('connect_init', {peerId: targetPeerId, error: e});
            pendingConnections.delete(targetPeerId);
            // connections.delete(targetPeerId); // Remove placeholder if used
        }
    }

    /** Connects to all peers currently in the knownPeers set (excluding self and already connected/pending) */
    function connectToKnownPeers() {
        logMessage(`Attempting connections to ${knownPeers.size - 1} known peers...`, 'info');
        knownPeers.forEach(peerId => {
            if (peerId !== localPeerId && !connections.has(peerId) && !pendingConnections.has(peerId)) {
                connectToPeer(peerId);
            }
        });
    }


    /** Removes a connection and notifies the application */
    function removeConnection(peerIdToRemove) {
        if (!peerIdToRemove) return;

        pendingConnections.delete(peerIdToRemove); // Remove from pending set if present

        const conn = connections.get(peerIdToRemove);
        if (conn) {
            connections.delete(peerIdToRemove); // Remove from map
            logMessage(`Removed connection for ${peerIdToRemove.slice(-6)}. Total connected: ${connections.size}`, 'info');
            config.onPeerLeft(peerIdToRemove); // Notify application

            // Close the connection object if it exists and is open
            if (conn !== 'connecting' && conn !== 'accepting' && typeof conn === 'object' && conn.open) {
                logMessage(`Closing connection object for ${peerIdToRemove.slice(-6)}`, 'info');
                try {
                    conn.close();
                } catch (e) { /* ignore */ }
            }
        }
        // Keep peer in knownPeers for potential reconnection attempts via discovery
        // knownPeers.delete(peerIdToRemove); // Don't remove from knownPeers on disconnect
    }

    /** Sends the current list of known peers to a specific connection */
    function sendPeerList(conn) {
        if (!conn || !conn.open) return;
        const remotePeerId = conn.peer;
        const peersToSend = Array.from(knownPeers).filter(id => id !== remotePeerId); // Exclude recipient

        if (peersToSend.length > 0) {
            logMessage(`Sending known peer list (${peersToSend.length}) to ${remotePeerId.slice(-6)}`, 'debug');
            const message = {
                type: '_mp_internal', // Internal message type
                payload: {
                    type: 'peer_list',
                    peers: peersToSend
                }
            };
            try {
                conn.send(message);
            } catch (e) {
                logMessage(`Error sending peer list to ${remotePeerId.slice(-6)}: ${e.message}`, 'error');
                removeConnection(remotePeerId);
            }
        }
    }

    /** Sends initial application-specific sync data to a new peer */
    function sendInitialAppSync(conn) {
        if (!conn || !conn.open || !config.getInitialSyncData) return;

        const syncData = config.getInitialSyncData();
        // Check if syncData is meaningful (not null/undefined/empty object)
        if (syncData && (typeof syncData !== 'object' || Object.keys(syncData).length > 0)) {
            const remotePeerId = conn.peer;
            logMessage(`Sending initial app sync data to ${remotePeerId.slice(-6)}`, 'info');

            const message = {
                type: 'initialAppSync', // Specific type for app data
                payload: syncData
            };
            try {
                conn.send(message);
            } catch (e) {
                logMessage(`Error sending initial app sync to ${remotePeerId.slice(-6)}: ${e.message}`, 'error');
                removeConnection(remotePeerId);
            }
        } else {
            // logMessage("No initial app sync data provided by application.", 'debug');
        }
    }


    /** Handles received data, parses message, calls app callback or handles internal messages */
    function handleReceivedData(data, sourceConn) {
        const sourcePeerId = sourceConn?.peer;
        if (!sourcePeerId) return; // Ignore data from unknown source

        try {
            // --- Handle Internal Messages ---
            if (data && data.type === '_mp_internal' && data.payload) {
                handleInternalMessage(data.payload, sourcePeerId, sourceConn);
                return; // Don't process internal messages further
            }

            // --- Handle Initial App Sync Data ---
            if (data && data.type === 'initialAppSync' && data.payload) {
                logMessage(`Received initial app sync from ${sourcePeerId.slice(-6)}`, 'info');
                config.onInitialSync(data.payload); // Pass payload to app
                return; // Don't process as regular data
            }

            // --- Handle Application/Broadcast Messages ---
            if (data && data.payload && data.messageId && data.originalSenderId) {
                const { payload, messageId, originalSenderId } = data;

                // Ignore own messages or already seen messages
                if (seenMessageIds.has(messageId) || originalSenderId === localPeerId) {
                    return;
                }
                seenMessageIds.add(messageId);
                // Simple cleanup for seen messages
                if (seenMessageIds.size > MAX_SEEN_MESSAGES) {
                    const oldestIds = Array.from(seenMessageIds).slice(0, MAX_SEEN_MESSAGES / 5);
                    oldestIds.forEach(id => seenMessageIds.delete(id));
                }


                // Process the payload via application callback
                config.onDataReceived(originalSenderId, payload);

                // Forward the message to other connected peers (simple broadcast)
                // Avoid re-broadcasting internal messages or sync data here
                broadcast(data, sourceConn); // Forward the original wrapped message

            } else {
                // Handle raw data or non-standard messages if necessary, pass to app
                logMessage(`Received non-standard data from ${sourcePeerId.slice(-6)}`, 'debug');
                config.onDataReceived(sourcePeerId, data); // Pass raw data to app
            }
        } catch (e) {
            logMessage(`Error processing data from ${sourcePeerId.slice(-6)}: ${e.message}`, 'error');
            console.error(e); // Log stack trace
        }
    }

    /** Handles internal library messages */
    function handleInternalMessage(payload, sourcePeerId, sourceConn) {
        logMessage(`Handling internal message type '${payload.type}' from ${sourcePeerId.slice(-6)}`, 'debug');
        switch (payload.type) {
            case 'peer_list':
                // Received a list of peers from another node
                if (Array.isArray(payload.peers)) {
                    logMessage(`Received peer list (${payload.peers.length}) from ${sourcePeerId.slice(-6)}`, 'debug');
                    let newPeersFound = 0;
                    payload.peers.forEach(peerId => {
                        if (peerId !== localPeerId && !knownPeers.has(peerId)) {
                            knownPeers.add(peerId);
                            newPeersFound++;
                            connectToPeer(peerId); // Attempt to connect to newly discovered peers
                        }
                    });
                    if (newPeersFound > 0) {
                        logMessage(`Discovered ${newPeersFound} new peers from ${sourcePeerId.slice(-6)}. Total known: ${knownPeers.size}`, 'info');
                    }
                }
                break;
            case 'reject':
                logMessage(`Connection rejected by ${sourcePeerId.slice(-6)}. Reason: ${payload.reason || 'Unknown'}`, 'warn');
                removeConnection(sourcePeerId); // Remove the connection attempt
                knownPeers.delete(sourcePeerId); // Assume peer is not connectable for now
                break;
            // Add other internal message types if needed
            default:
                logMessage(`Received unknown internal message type: ${payload.type}`, 'warn');
        }
    }


    /** Starts the periodic peer discovery broadcast */
    function startDiscovery() {
        if (discoveryInterval) clearInterval(discoveryInterval); // Clear existing interval
        logMessage("Starting periodic peer discovery broadcast...", 'info');
        discoveryInterval = setInterval(() => {
            broadcastPeerListToAll(); // Broadcast our known peers to everyone connected
            // Optionally, also try connecting to any known peers we aren't connected to
            connectToKnownPeers();
        }, DISCOVERY_INTERVAL_MS);
    }

    /** Stops the periodic peer discovery broadcast */
    function stopDiscovery() {
        if (discoveryInterval) {
            logMessage("Stopping periodic peer discovery broadcast.", 'info');
            clearInterval(discoveryInterval);
            discoveryInterval = null;
        }
    }

    /** Broadcasts the local peer list to all active connections */
    function broadcastPeerListToAll() {
        if (connections.size === 0) return; // No one to send to
        logMessage(`Broadcasting peer list (${knownPeers.size}) to ${connections.size} connected peers.`, 'debug');
        const peersToSend = Array.from(knownPeers); // Send full list including self

        const message = {
            type: '_mp_internal',
            payload: {
                type: 'peer_list',
                peers: peersToSend
            }
        };

        connections.forEach((conn, peerId) => {
            if (conn && conn.open) {
                try {
                    conn.send(message);
                } catch (e) {
                    logMessage(`Error broadcasting peer list to ${peerId.slice(-6)}: ${e.message}`, 'error');
                    removeConnection(peerId);
                }
            }
        });
    }

    /** Resets the library state */
    function resetState() {
        logMessage("Resetting multiplayer library state.", 'warn');
        stopDiscovery(); // Stop discovery process
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        // Close all existing connections
        connections.forEach(conn => {
            if (conn && conn.close) {
                try { conn.close(); } catch(e) {/* ignore */}
            }
        });
        connections.clear();
        pendingConnections.clear();
        knownPeers.clear();
        seenMessageIds.clear();

        // Destroy the PeerJS instance
        if (peer && !peer.destroyed) {
            try {
                peer.destroy();
                logMessage("PeerJS instance destroyed.", "info");
            } catch (e) { logMessage(`Error destroying PeerJS instance: ${e.message}`, "error"); }
        }
        peer = null;
        localPeerId = null;
        MPLib.localPeerId = null; // Update exposed property

        config.onStatusUpdate("Network disconnected.");
    }

    // --- Public API ---
    return {
        initialize,
        /**
         * Broadcasts application data to all connected peers.
         * @param {any} appPayload - The data payload from the application.
         * @param {Peer.DataConnection} [senderConn=null] - Internal: Connection the message originally came from (to avoid loops).
         */
        broadcast: (appPayload, senderConn = null) => {
            if (!peer || peer.destroyed || connections.size === 0) {
                logMessage("Cannot broadcast: No open connections or peer not ready.", 'warn');
                return;
            }
            if (!appPayload) {
                logMessage("Broadcast payload cannot be empty.", 'warn');
                return;
            }

            // Check if it's already a wrapped message (internal forwarding)
            let messageToSend;
            if (appPayload && appPayload.messageId && appPayload.originalSenderId) {
                messageToSend = appPayload; // It's already wrapped, forward as is
            } else {
                // Wrap the application payload for broadcast
                messageToSend = {
                    messageId: generateUniqueId('bcast'),
                    originalSenderId: localPeerId, // This peer is the original sender
                    payload: appPayload,
                    timestamp: Date.now() // Optional timestamp
                };
            }


            // Add to seen immediately to prevent loopback if message arrives quickly
            seenMessageIds.add(messageToSend.messageId);

            logMessage(`Broadcasting message ${messageToSend.messageId.slice(-6)} from ${messageToSend.originalSenderId.slice(-6)}`, 'debug');

            connections.forEach((conn, peerId) => {
                // Don't send back to the source connection if forwarding
                if (conn && conn.open && conn !== senderConn) {
                    try {
                        conn.send(messageToSend);
                    } catch (e) {
                        logMessage(`Error broadcasting message to ${peerId.slice(-6)}: ${e.message}`, 'error');
                        removeConnection(peerId);
                    }
                }
            });
        },
        /**
         * Sends data directly to a specific peer.
         * @param {string} targetPeerId - The ID of the peer to send to.
         * @param {any} payload - The data payload to send.
         */
        sendDirect: (targetPeerId, payload) => {
            if (!targetPeerId || !payload) {
                logMessage("Direct send requires targetPeerId and payload.", 'warn');
                return;
            }
            if(targetPeerId === localPeerId) {
                logMessage("Cannot send direct message to self.", "warn");
                return;
            }

            const conn = connections.get(targetPeerId);
            if (conn && conn !== 'connecting' && conn !== 'accepting' && conn.open) {
                try {
                    // Send directly without broadcast wrapping
                    conn.send(payload);
                    logMessage(`Sent direct message to ${targetPeerId.slice(-6)}`, 'debug');
                } catch (e) {
                    logMessage(`Error sending direct message to ${targetPeerId.slice(-6)}: ${e.message}`, 'error');
                    removeConnection(targetPeerId);
                }
            } else {
                logMessage(`No open connection to ${targetPeerId.slice(-6)} for direct message. Attempting connect.`, 'warn');
                connectToPeer(targetPeerId); // Try to connect if not already connected
                // TODO: Consider queuing the message? For now, just attempts connect.
            }
        },
        /** Disconnects and cleans up the PeerJS instance. */
        disconnect: () => {
            logMessage("Disconnecting multiplayer library.", 'info');
            resetState();
        },

        // --- Accessors ---
        getConnections: () => new Map(connections), // Return a copy of active connections
        getKnownPeers: () => new Set(knownPeers), // Return a copy of known peers
        getLocalPeerId: () => localPeerId,

        // --- Direct State Exposure (use with caution) ---
        localPeerId: localPeerId,
        connections: connections, // Expose map directly (read-only recommended)
    };

})();