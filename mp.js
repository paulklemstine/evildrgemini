/**
 * Multiplayer Library using PeerJS (Refactored)
 *
 * Provides core functionality for establishing P2P connections,
 * managing peers, and broadcasting/handling messages.
 * This version incorporates refactoring to reduce redundancy.
 *
 * Integration:
 * 1. Import { MPLib } from './mp.js' in your main script.
 * 2. Call `MPLib.initialize(...)` to start the connection process.
 * ... (rest of the comments) ...
 */

// --- State variables ---
let peer = null;
let localPeerId = null;
let hostPeerId = null;
let targetHostId = 'default-mp-channel'; // Default target host ID
let isHost = false;
let isAttemptingHostId = false; // Tracks if the current initialization attempt is for the targetHostId
let initialSyncComplete = false;
const connections = new Map(); // Map<peerId, DataConnection | 'connecting'>
const pendingConnections = new Set(); // Set<peerId> - Peers we are actively trying to connect *to*
const seenMessageIds = new Set();
const MAX_SEEN_MESSAGES = 1000;
const MAX_CONNECTIONS = 8;
const MESSAGE_TTL = 4; // Default gossip message time-to-live
let hostCheckTimeout = null; // Timeout handle for assuming host role if connection fails
let config = { // Default configuration, override via initialize()
    debugLevel: 0,
    targetHostId: targetHostId, // Allow overriding default target ID via options
    forceClientOnly: false, // If true, never attempts to become host
    onStatusUpdate: (msg) => logMessage(msg, 'info'),
    onError: (type, err) => logMessage(`Error (${type}): ${err?.message || err}`, 'error'),
    onPeerJoined: (peerId, conn) => logMessage(`Peer joined: ${peerId.slice(-6)}`, 'info'),
    onPeerLeft: (peerId) => logMessage(`Peer left: ${peerId.slice(-6)}`, 'info'),
    onDataReceived: (peerId, data) => logMessage(`Data from ${peerId.slice(-6)}: ${JSON.stringify(data)}`, 'info'),
    onConnectedToHost: (hostId) => logMessage(`Connected to host: ${hostId.slice(-6)}`, 'info'),
    onBecameHost: () => logMessage(`Became host!`, 'info'),
    onInitialSync: (syncData) => logMessage(`Received initial sync: ${JSON.stringify(syncData)}`, 'info'),
    getInitialSyncData: () => ({}), // App should provide function to get its sync data
    maxConnections: MAX_CONNECTIONS,
    messageTTL: MESSAGE_TTL,
    hostConnectionTimeoutMs: 7000, // How long to wait for host connection before assuming role
};

// --- Utility Functions ---
function generateUniqueId(prefix = 'msg') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function logMessage(message, type = 'info') {
    // Basic logging, replace/extend as needed (e.g., UI updates)
    console[type === 'error' ? 'error' : (type === 'warn' ? 'warn' : 'log')](`[MPLib] ${message}`);
}

// --- Core PeerJS Functions ---

/**
 * Initializes or re-initializes the PeerJS connection.
 * Destroys any existing peer and resets state before creating a new one.
 * Attempts to claim the targetHostId unless forceClientOnly is true.
 * @param {object} options - Configuration options to override defaults.
 */
function initialize(options = {}) {
    // Destroy existing peer instance safely
    if (peer && !peer.destroyed) {
        logMessage("Re-initializing PeerJS. Destroying previous instance.", 'warn');
        // Detach listeners before destroying to prevent spurious events during reset
        peer.off('open');
        peer.off('connection');
        peer.off('disconnected');
        peer.off('close');
        peer.off('error');
        try { peer.destroy(); } catch (e) { logMessage(`Error destroying previous peer: ${e.message}`, 'warn'); }
    }
    peer = null; // Ensure peer is null before attempting creation

    // Merge options and reset state variables
    config = { ...config, ...options };
    targetHostId = config.targetHostId || targetHostId;
    localPeerId = null; // Reset local ID
    initialSyncComplete = false;
    hostPeerId = null;
    isHost = false;
    connections.clear();
    pendingConnections.clear();
    seenMessageIds.clear();
    if (hostCheckTimeout) { clearTimeout(hostCheckTimeout); hostCheckTimeout = null; }

    // Determine if we should attempt to become the host
    const attemptHost = !config.forceClientOnly;
    const peerIdToAttempt = attemptHost ? targetHostId : undefined; // undefined = random ID
    isAttemptingHostId = attemptHost; // Set state flag for error handling

    // Log intent
    if (attemptHost) {
        logMessage(`Initializing PeerJS... Attempting target ID: ${targetHostId.slice(-6)}`);
        config.onStatusUpdate(`Initializing network as potential host...`);
    } else {
        logMessage("Initializing with random ID (Client Mode)...");
        config.onStatusUpdate("Connecting as client...");
    }

    // Attempt to create the new Peer instance
    try {
        peer = new Peer(peerIdToAttempt, { debug: config.debugLevel });
        setupPeerListeners(peer); // Setup listeners immediately after creation
    } catch (e) {
        logMessage(`Fatal PeerJS initialization error: ${e.message}`, 'error');
        config.onError('init', e);
        resetState(); // Reset fully on immediate instantiation error
    }
}


/**
 * Attaches essential event listeners to the PeerJS peer object.
 * Handles core events like open, connection, errors, etc.
 * @param {Peer} currentPeer - The PeerJS peer instance.
 */
function setupPeerListeners(currentPeer) {
    if (!currentPeer) return;

    // Remove any potentially lingering listeners from previous instances (belt-and-suspenders)
    currentPeer.off('open');
    currentPeer.off('connection');
    currentPeer.off('disconnected');
    currentPeer.off('close');
    currentPeer.off('error');

    currentPeer.on('open', (id) => {
        if (!id || currentPeer.destroyed) { // Check if peer got destroyed before open resolved
            logMessage("Error: Peer opened with null ID or was destroyed.", 'error');
            config.onError('null_id', 'PeerJS returned a null ID or was destroyed');
            // If we were trying to be host and failed, try again as client
            if (isAttemptingHostId && !config.forceClientOnly) {
                logMessage("Retrying initialization as client due to open error.", 'warn');
                initialize({ ...config, forceClientOnly: true });
            } else {
                resetState(); // Full reset if client init fails this way
            }
            return;
        }

        localPeerId = id;
        logMessage(`PeerJS opened. Local ID: ${id.slice(-6)}`, 'info');

        if (isAttemptingHostId && id === targetHostId) {
            // Successfully claimed the host ID
            becomeHost();
        } else {
            // Operating as a client (either by choice, forceClientOnly, or target ID was taken)
            isHost = false;
            if (isAttemptingHostId) {
                // This means we tried for targetHostId but got a different ID
                logMessage(`Target ID ${targetHostId.slice(-6)} taken/unavailable. Operating as client ${id.slice(-6)}.`, 'warn');
                isAttemptingHostId = false; // No longer trying for the host ID in this session
            } else {
                logMessage(`Operating as client ${id.slice(-6)}.`, 'info');
            }
            config.onStatusUpdate(`Connected as ${id.slice(-6)}. Looking for host ${targetHostId.slice(-6)}...`);
            connectToPeer(targetHostId); // Attempt to connect to the designated host

            // Set a timeout: if we don't connect to the host within a certain time, assume host role (unless client only)
            if (!config.forceClientOnly) {
                if (hostCheckTimeout) clearTimeout(hostCheckTimeout);
                hostCheckTimeout = setTimeout(() => {
                    if (!connections.has(targetHostId) && !isHost && !initialSyncComplete) {
                        logMessage(`Host connection to ${targetHostId.slice(-6)} timed out. Assuming host role.`, 'warn');
                        becomeHost(); // Take over as host
                    }
                }, config.hostConnectionTimeoutMs);
            }
        }
    });

    currentPeer.on('connection', (conn) => {
        logMessage(`Incoming connection request from ${conn.peer.slice(-6)}`, 'info');
        handleIncomingConnection(conn);
    });

    currentPeer.on('disconnected', () => {
        // Disconnected from the PeerJS signaling server
        logMessage("PeerJS disconnected from signaling server.", 'warn');
        config.onStatusUpdate("Server disconnected. Reconnecting...");
        try {
            if (currentPeer && !currentPeer.destroyed && !currentPeer.disconnected) {
                // PeerJS documentation suggests reconnect is often automatic,
                // but we can try explicitly if needed. Check PeerJS version specifics.
                // currentPeer.reconnect(); // May not be necessary or could cause issues
            }
        } catch (e) {
            logMessage(`Error attempting reconnect: ${e.message}`, 'error');
            config.onError('reconnect', e);
        }
    });

    currentPeer.on('close', () => {
        // Peer instance is permanently closed (usually after .destroy())
        logMessage("PeerJS connection closed permanently.", 'warn');
        // Don't call resetState here as it might be part of intentional shutdown/re-init
        // config.onError('close', 'Peer instance closed'); // Optional: notify app
    });

    currentPeer.on('error', (err) => {
        logMessage(`PeerJS Error: ${err.type} - ${err.message || ''}`, 'error');
        config.onError(err.type, err);

        if (err.type === 'unavailable-id' && isAttemptingHostId && err.message?.includes(targetHostId)) {
            // Failed to get the desired host ID
            logMessage(`Target ID ${targetHostId.slice(-6)} unavailable. Re-initializing as client.`, 'warn');
            const currentOptions = { ...config }; // Capture current config
            // Need to clean up the failed peer attempt before re-initializing.
            // Initialize will handle destroying the (now failed) peer.
            initialize({ ...currentOptions, forceClientOnly: true });
            // Note: Re-initializing resets all state, including potential connections.
            // This is generally acceptable if the host ID claim fails early.

        } else if (err.type === 'peer-unavailable') {
            const unavailablePeerId = err.message?.match(/peer\s(.*?)\s/)?.[1];
            if (unavailablePeerId) {
                logMessage(`Peer ${unavailablePeerId.slice(-6)} unavailable. Removing connection.`, 'warn');
                removeConnection(unavailablePeerId);
                // If the unavailable peer was the host we were trying to connect to initially
                if (unavailablePeerId === targetHostId && !isHost && !config.forceClientOnly && !initialSyncComplete) {
                    logMessage(`Host ${targetHostId.slice(-6)} unavailable. Assuming host role.`, 'warn');
                    becomeHost();
                }
            }
        } else if (['network', 'server-error', 'socket-error', 'webrtc', 'browser-incompatible'].includes(err.type)) {
            // More serious errors might require a full reset or specific handling
            logMessage(`Potential network/compatibility issue: ${err.type}. Consider re-initializing if problems persist.`, 'error');
            // Optionally attempt reconnect or full reset depending on severity/persistence
            if (err.type !== 'browser-incompatible') {
                try {
                    if (currentPeer && !currentPeer.destroyed && !currentPeer.disconnected) {
                        // currentPeer.reconnect(); // Cautious about auto-reconnect here
                    }
                } catch (e) {}
            } else {
                // Browser incompatible = likely fatal for this session
                resetState();
                config.onStatusUpdate("Error: Browser not supported.");
            }
        }
    });
}


/**
 * Handles an incoming connection request from another peer.
 * Validates the connection and sets up listeners if accepted.
 * @param {DataConnection} conn - The incoming PeerJS DataConnection object.
 */
function handleIncomingConnection(conn) {
    const remotePeerId = conn.peer;
    if (!remotePeerId) {
        logMessage("Incoming connection with no peer ID.", 'warn');
        try { conn.close(); } catch(e){} // Attempt to close invalid connection
        return;
    }

    const existingConn = connections.get(remotePeerId);

    // Check connection limits
    if (connections.size >= config.maxConnections && !existingConn) {
        logMessage(`Max connections (${config.maxConnections}) reached. Rejecting ${remotePeerId.slice(-6)}`, 'warn');
        rejectConnection(conn, 'Room full');
        return;
    }

    // Handle duplicate connection attempts
    if (existingConn) {
        if (existingConn === 'connecting') {
            // We were trying to connect to them, they connected to us first. Use their connection.
            logMessage(`Incoming conn from ${remotePeerId.slice(-6)} replaces pending outgoing.`, 'info');
            pendingConnections.delete(remotePeerId); // No longer pending outgoing
        } else if (existingConn.open) {
            // Already have an open connection with this peer.
            logMessage(`Duplicate connection attempt from ${remotePeerId.slice(-6)}. Rejecting.`, 'warn');
            rejectConnection(conn, 'Duplicate connection');
            return;
        } else {
            // Existing connection wasn't open (maybe errored/closed without cleanup). Replace it.
            logMessage(`Replacing existing non-open connection for ${remotePeerId.slice(-6)}.`, 'info');
            try { existingConn.close(); } catch(e){} // Clean up old one if possible
        }
    }

    // Accept the connection - setup listeners for open, data, close, error
    conn.on('open', () => {
        logMessage(`Connection opened with ${remotePeerId.slice(-6)} (incoming)`);
        // Final check for limits in case connections filled up while this one was opening
        if (connections.size >= config.maxConnections && !connections.has(remotePeerId)) {
            logMessage(`Connection ${remotePeerId.slice(-6)} opened, but room now full. Closing.`, 'warn');
            try { conn.close(); } catch(e){}
            removeConnection(remotePeerId); // Ensure state cleanup if we immediately close
            return;
        }
        setupConnection(conn); // Finalize the connection setup
    });
    conn.on('error', (err) => {
        logMessage(`Pre-open connection error with ${remotePeerId.slice(-6)}: ${err.type}`, 'error');
        removeConnection(remotePeerId); // Clean up state if incoming conn errors before opening
    });
    conn.on('close', () => {
        logMessage(`Pre-open connection closed with ${remotePeerId.slice(-6)}`, 'warn');
        removeConnection(remotePeerId); // Clean up state if incoming conn closes before opening
    });

    // Add to connections map immediately to reserve the slot (value is the conn object itself)
    connections.set(remotePeerId, conn);
}

/**
 * Sends a rejection message and closes a connection attempt.
 * @param {DataConnection} conn - The connection to reject.
 * @param {string} reason - The reason for rejection.
 */
function rejectConnection(conn, reason = 'Connection rejected') {
    try {
        // Wait for open briefly to try and send a reason, then close.
        conn.on('open', () => {
            try { conn.send({ type: 'error', payload: { message: reason } }); } catch(e) {/* ignore send error */}
            setTimeout(() => { try { conn.close(); } catch(e) {/* ignore close error */} }, 50);
        });
        // If it errors or closes before opening, just let it happen.
        conn.on('error', (err) => { logMessage(`Error during rejection for ${conn?.peer?.slice(-6)}: ${err.type}`, 'warn');});
        conn.on('close', () => { logMessage(`Connection closed during rejection for ${conn?.peer?.slice(-6)}`, 'info');});
        // If conn never opens, it will eventually be cleaned up or GC'd.
    } catch (e) {
        logMessage(`Error during connection rejection setup: ${e.message}`, 'error');
    }
}

/**
 * Finalizes setup for an opened DataConnection (incoming or outgoing).
 * Attaches data, close, and error handlers.
 * Manages state updates (host connection, initial sync).
 * @param {DataConnection} conn - The open DataConnection.
 */
function setupConnection(conn) {
    const remotePeerId = conn.peer;
    if (!remotePeerId || !conn.open) {
        logMessage(`Attempted to setup non-open/invalid connection with ${remotePeerId?.slice(-6)}.`, 'warn');
        return; // Should not happen if called correctly from 'open' handlers
    }

    // Ensure this connection is the one stored (handles race conditions)
    if (connections.get(remotePeerId) !== conn && connections.get(remotePeerId) !== 'connecting') {
        logMessage(`Stale connection object found for ${remotePeerId.slice(-6)} during setup. Closing old.`, 'warn');
        try { connections.get(remotePeerId)?.close(); } catch(e) {}
    } else if (connections.get(remotePeerId) === 'connecting'){
        logMessage(`Promoting 'connecting' state for ${remotePeerId.slice(-6)}`, 'info');
    }

    connections.set(remotePeerId, conn); // Store the final, open connection object
    pendingConnections.delete(remotePeerId); // No longer pending outgoing

    logMessage(`Connection setup complete with ${remotePeerId.slice(-6)}. Total: ${connections.size}`, 'info');
    config.onPeerJoined(remotePeerId, conn); // Notify application

    // Host-specific actions
    if (isHost) {
        sendInitialSync(conn); // Send current state to new peer
    }

    // Client-specific actions
    if (remotePeerId === targetHostId) {
        logMessage(`Confirmed connection to designated host: ${targetHostId.slice(-6)}`, 'info');
        hostPeerId = targetHostId; // Set the host ID
        if (hostCheckTimeout) { clearTimeout(hostCheckTimeout); hostCheckTimeout = null; } // Cancel host assumption timeout
        config.onConnectedToHost(targetHostId); // Notify application
        // Client doesn't request sync, waits for host to send it.
    }

    // Remove previous handlers and attach final ones
    conn.off('data');
    conn.off('close');
    conn.off('error');

    conn.on('data', (data) => {
        handleReceivedData(data, conn);
    });

    conn.on('close', () => {
        logMessage(`Connection closed with ${remotePeerId.slice(-6)}`, 'warn');
        removeConnection(remotePeerId); // Clean up on close
    });

    conn.on('error', (err) => {
        logMessage(`Connection error with ${remotePeerId.slice(-6)}: ${err.type}`, 'error');
        config.onError('connection', err);
        removeConnection(remotePeerId); // Clean up on error
    });
}

/**
 * Initiates an outgoing connection to a target peer ID.
 * @param {string} targetPeerId - The ID of the peer to connect to.
 */
function connectToPeer(targetPeerId) {
    if (!targetPeerId || targetPeerId === localPeerId || !peer || peer.destroyed) {
        // logMessage(`Skipping connection to ${targetPeerId}: invalid target or peer state.`, 'debug');
        return;
    }
    // Avoid connecting if already connected or connection attempt is in progress
    if (connections.has(targetPeerId)) {
        // logMessage(`Skipping connection to ${targetPeerId}: connection already exists or pending.`, 'debug');
        return;
    }
    // Check connection limits before initiating
    if (connections.size >= config.maxConnections) {
        logMessage(`Cannot connect to ${targetPeerId.slice(-6)}, max connections (${config.maxConnections}) reached.`, 'warn');
        return;
    }

    logMessage(`Attempting outgoing connection to ${targetPeerId.slice(-6)}...`, 'info');
    if (targetPeerId === targetHostId) {
        config.onStatusUpdate(`Connecting to host ${targetPeerId.slice(-6)}...`);
    } else {
        config.onStatusUpdate(`Connecting to peer ${targetPeerId.slice(-6)}...`);
    }

    // Mark as pending and reserve space in connections map
    pendingConnections.add(targetPeerId);
    connections.set(targetPeerId, 'connecting'); // Mark as attempting connection

    try {
        const conn = peer.connect(targetPeerId, { reliable: true }); // Use reliable transport

        conn.on('open', () => {
            logMessage(`Outgoing connection to ${targetPeerId.slice(-6)} opened.`);
            // Check if state changed while opening (e.g., incoming connection established first)
            if (connections.get(targetPeerId) === 'connecting') {
                // State is still pending, finalize setup with this connection
                setupConnection(conn);
            } else if (connections.get(targetPeerId) !== conn) {
                // State changed, likely an incoming connection won, or connection was removed. Close this outgoing attempt.
                logMessage(`State changed for ${targetPeerId.slice(-6)} during outgoing open. Closing this attempt.`, 'warn');
                try { conn.close(); } catch(e) {}
                // If the state is still 'connecting' somehow, clean it up. Should ideally be handled by incoming connection flow.
                if(connections.get(targetPeerId) === 'connecting') {
                    connections.delete(targetPeerId);
                    pendingConnections.delete(targetPeerId);
                }
            } else {
                // Connection object already matches the one in the map (could happen with fast connections/race conditions)
                logMessage(`Connection object for ${targetPeerId.slice(-6)} already set correctly during open.`, 'info');
                // setupConnection should have been called already or will be by another path, avoid calling twice.
            }
        });

        conn.on('error', (err) => {
            logMessage(`Failed to connect to ${targetPeerId.slice(-6)}: ${err.type}`, 'error');
            config.onError('connect_error', err);
            // Clean up only if we were still in the 'connecting' state for this target
            if (connections.get(targetPeerId) === 'connecting') {
                connections.delete(targetPeerId);
            }
            pendingConnections.delete(targetPeerId); // Always remove from pending on error

            // If connection to the designated host failed, potentially assume host role
            if (targetPeerId === targetHostId && !isHost && !config.forceClientOnly && !initialSyncComplete) {
                logMessage(`Failed connection to intended host ${targetHostId.slice(-6)}. Assuming host role.`, 'warn');
                becomeHost();
            }
        });
        conn.on('close', () => {
            // Connection closed before opening fully
            logMessage(`Outgoing connection attempt to ${targetPeerId.slice(-6)} closed before open.`, 'warn');
            if (connections.get(targetPeerId) === 'connecting') {
                connections.delete(targetPeerId);
            }
            pendingConnections.delete(targetPeerId);
        });

    } catch (e) {
        logMessage(`Error initiating connection to ${targetPeerId.slice(-6)}: ${e.message}`, 'error');
        config.onError('connect_init', e);
        // Clean up state if initiation failed immediately
        if (connections.get(targetPeerId) === 'connecting') connections.delete(targetPeerId);
        pendingConnections.delete(targetPeerId);
    }
}

/**
 * Cleans up state associated with a peer connection (e.g., on close or error).
 * @param {string} peerIdToRemove - The ID of the peer whose connection to remove.
 */
function removeConnection(peerIdToRemove) {
    if (!peerIdToRemove) return;

    pendingConnections.delete(peerIdToRemove); // Ensure it's not marked as pending

    const conn = connections.get(peerIdToRemove);
    if (conn) { // Check if an entry exists
        connections.delete(peerIdToRemove); // Remove from map
        logMessage(`Removed connection entry for ${peerIdToRemove.slice(-6)}. Total: ${connections.size}`, 'info');
        config.onPeerLeft(peerIdToRemove); // Notify application

        // Attempt to close the connection object if it's not just the 'connecting' placeholder
        if (conn !== 'connecting' && typeof conn === 'object' && conn.close) {
            try {
                conn.off('data'); // Remove listeners before closing
                conn.off('close');
                conn.off('error');
                conn.close();
            } catch (e) {
                logMessage(`Error closing connection for ${peerIdToRemove.slice(-6)} during removal: ${e.message}`, 'warn');
            }
        }

        // Handle host disconnection logic
        if (peerIdToRemove === hostPeerId && !isHost) {
            logMessage("Lost connection to host!", 'error');
            config.onError('host_disconnect', 'Lost connection to host');
            hostPeerId = null; // Clear host ID
            initialSyncComplete = false; // Need sync again if we find a new host
            config.onStatusUpdate("Lost connection to host. Searching...");
            // If not forced client, try to become the host now
            if (!config.forceClientOnly) {
                logMessage("Attempting to assume host role after losing connection to previous host.", 'warn');
                becomeHost(); // Try to take over
            } else {
                // If forced client, may need logic to find a new host or wait.
                // Currently, it would wait for a new peer claiming targetHostId to connect.
            }
        }

        // Trigger UI update if needed (using a globally available function or event system)
        if (typeof updateControlPanel === 'function') {
            updateControlPanel();
        }
    } else {
        // logMessage(`Attempted to remove non-existent connection: ${peerIdToRemove.slice(-6)}`, 'debug');
    }
}

/**
 * Sends the initial synchronization data from the host to a newly connected peer.
 * Includes application data and the list of currently connected peers.
 * @param {DataConnection} conn - The connection to send the sync data to.
 */
function sendInitialSync(conn) {
    if (!isHost || !conn || !conn.open) return;
    const remotePeerId = conn.peer;
    logMessage(`Sending initial sync data to ${remotePeerId.slice(-6)}`, 'info');

    try {
        // Get application-specific data first
        const appSyncData = config.getInitialSyncData() || {};

        // Add peer list (excluding the recipient)
        const peerList = [localPeerId, ...Array.from(connections.keys())]
            .filter(id => id && id !== remotePeerId && connections.get(id) !== 'connecting'); // Filter out self, recipient, and pending

        const syncMessage = {
            type: 'initialSync',
            payload: {
                ...appSyncData, // Spread application data into payload
                peers: peerList // Add peer list under 'peers' key
            },
            senderId: localPeerId // Identify the host
        };
        conn.send(syncMessage);
    } catch (e) {
        logMessage(`Error sending initial sync to ${remotePeerId.slice(-6)}: ${e.message}`, 'error');
        // Optionally remove connection if send fails critically
        // removeConnection(remotePeerId);
    }
}

/**
 * Processes data received from a peer connection.
 * Handles initial sync messages, regular data messages, and gossip propagation.
 * @param {any} data - The raw data received.
 * @param {DataConnection} sourceConn - The connection the data came from.
 */
function handleReceivedData(data, sourceConn) {
    const sourcePeerId = sourceConn?.peer;
    if (!sourcePeerId) {
        logMessage("Received data from unknown source.", 'warn');
        return;
    }

    try {
        // --- Handle Initial Sync ---
        if (data && data.type === 'initialSync' && data.payload) {
            if (!initialSyncComplete && !isHost) { // Only process if we haven't synced yet and aren't the host
                logMessage(`Received initial sync from host ${sourcePeerId.slice(-6)}`, 'info');
                initialSyncComplete = true;
                isHost = false; // Ensure we know we're a client
                hostPeerId = data.senderId || sourcePeerId; // Trust senderId if present, else source peer

                if (hostCheckTimeout) { clearTimeout(hostCheckTimeout); hostCheckTimeout = null; } // Stop trying to become host
                config.onStatusUpdate(`Synced with host ${hostPeerId.slice(-6)}.`);
                config.onInitialSync(data.payload); // Pass full payload (app data + peers) to application

                // Connect to other peers mentioned in the sync data
                if (Array.isArray(data.payload.peers)) {
                    data.payload.peers.forEach(pid => {
                        if (pid && pid !== localPeerId && !connections.has(pid)) {
                            logMessage(`Connecting to peer ${pid.slice(-6)} based on sync data.`, 'info');
                            connectToPeer(pid);
                        }
                    });
                }
            } else {
                logMessage(`Ignoring subsequent/unnecessary initial sync from ${sourcePeerId.slice(-6)} (Already synced: ${initialSyncComplete}, Is host: ${isHost})`, 'warn');
            }
            return; // Stop processing after handling sync message
        }

        // --- Handle Regular/Gossip Messages ---
        let payload, msgId, originalSenderId, ttl;
        let isGossip = false;

        // Check if it's a structured gossip message
        if (data && typeof data === 'object' && data.payload && data.messageId && data.originalSenderId && data.ttl !== undefined) {
            isGossip = true;
            payload = data.payload;
            msgId = data.messageId;
            originalSenderId = data.originalSenderId;
            ttl = data.ttl;

            // Deduplication and loop prevention
            if (seenMessageIds.has(msgId) || originalSenderId === localPeerId) {
                // logMessage(`Ignoring seen/own message ${msgId.slice(-4)}`, 'debug');
                return;
            }
            seenMessageIds.add(msgId);
            // Prune seen messages to prevent memory leak
            if (seenMessageIds.size > MAX_SEEN_MESSAGES) {
                const oldestIds = Array.from(seenMessageIds).slice(0, MAX_SEEN_MESSAGES / 5); // Remove oldest 20%
                oldestIds.forEach(id => seenMessageIds.delete(id));
            }
        } else if (typeof data === 'object' && data !== null && data.type !== 'error') { // Treat other objects as direct messages (allow app-defined types)
            payload = data;
            originalSenderId = sourcePeerId; // Sender is the direct peer
        } else if (data.type === 'error') { // Handle rejection/error messages
            logMessage(`Received error message from ${sourcePeerId.slice(-6)}: ${data.payload?.message || 'Unknown error'}`, 'warn');
            return; // Don't process error payloads further here
        }
        else {
            logMessage(`Received non-object or unknown data format from ${sourcePeerId.slice(-6)}: ${JSON.stringify(data)}`, 'warn');
            return; // Ignore data we don't understand
        }

        // Pass the actual payload to the application's handler
        config.onDataReceived(originalSenderId, payload);

        // --- Gossip Propagation ---
        if (isGossip && ttl > 0 && connections.size > 1) { // Only forward if TTL > 0 and there are other peers
            const forwardedMessage = { ...data, ttl: ttl - 1 }; // Decrement TTL
            // logMessage(`Forwarding message ${msgId.slice(-4)} from ${originalSenderId.slice(-6)} with TTL ${ttl - 1}`, 'debug');
            broadcastInternal(forwardedMessage, [sourceConn]); // Broadcast to others, excluding the source
        }

    } catch (e) {
        logMessage(`Error processing data from ${sourcePeerId.slice(-6)}: ${e.message}`, 'error');
        console.error("Data processing error:", e, "Received data:", data); // Log stack trace and data
    }
}

/**
 * Internal function to broadcast data to all connected and open peers,
 * optionally excluding some connections.
 * @param {any} messageData - The data to send.
 * @param {DataConnection[]} [excludeConns=[]] - An array of connections to exclude from the broadcast.
 */
function broadcastInternal(messageData, excludeConns = []) {
    if (!peer || peer.destroyed || connections.size === 0) return;

    const excludeIds = excludeConns.map(conn => conn?.peer).filter(id => id); // Get IDs to exclude

    connections.forEach((conn, peerId) => {
        // Check if connection is valid, open, and not in the exclusion list
        if (conn !== 'connecting' && conn.open && !excludeIds.includes(peerId)) {
            try {
                conn.send(messageData);
            } catch (e) {
                logMessage(`Error broadcasting to ${peerId.slice(-6)}: ${e.message}`, 'error');
                // If sending fails, assume connection is bad and remove it
                removeConnection(peerId);
            }
        }
    });
}

/**
 * Sets the library's state to be the host.
 * Called when successfully claiming the target ID or when assuming the role after timeout/error.
 */
function becomeHost() {
    if (isHost) return; // Already host
    if (config.forceClientOnly) {
        logMessage("Cannot become host: forceClientOnly is set.", 'warn');
        return; // Cannot become host if forced client
    }

    isHost = true;
    hostPeerId = localPeerId; // Host's ID is our own ID
    initialSyncComplete = true; // Host is considered "synced" with itself
    isAttemptingHostId = false; // No longer trying, we *are* the host

    if (hostCheckTimeout) { clearTimeout(hostCheckTimeout); hostCheckTimeout = null; } // Clear any pending host check

    logMessage(`Assumed host role. ID: ${localPeerId.slice(-6)}`, 'info');
    config.onBecameHost(); // Notify application
    config.onStatusUpdate(`Hosting as ${localPeerId.slice(-6)} (${connections.size} peers)`);

    // Send initial sync to all currently connected peers (they might have connected before we became host)
    connections.forEach((conn) => {
        if (conn !== 'connecting' && conn.open) {
            sendInitialSync(conn);
        }
    });
    // Trigger UI update if needed
    if (typeof updateControlPanel === 'function') {
        updateControlPanel();
    }
}

/**
 * Resets the library state completely. Closes connections and destroys the PeerJS object.
 * Should be called before re-initializing or shutting down.
 */
function resetState() {
    logMessage("Resetting multiplayer library state.", 'warn');

    if (peer) {
        if (!peer.destroyed) {
            // Detach listeners before destroying
            peer.off('open');
            peer.off('connection');
            peer.off('disconnected');
            peer.off('close');
            peer.off('error');
            try { peer.destroy(); } catch (e) { logMessage(`Error destroying peer during reset: ${e.message}`, 'warn');}
        }
        peer = null;
    }

    localPeerId = null;
    isHost = false;
    hostPeerId = null;
    isAttemptingHostId = false;
    initialSyncComplete = false;

    // Clear connections and pending states
    connections.forEach((conn, peerId) => {
        if (conn !== 'connecting' && typeof conn === 'object' && conn.close) {
            try { conn.close(); } catch(e){} // Attempt to close gracefully
        }
    });
    connections.clear();
    pendingConnections.clear();
    seenMessageIds.clear();

    if (hostCheckTimeout) { clearTimeout(hostCheckTimeout); hostCheckTimeout = null; }

    config.onStatusUpdate("Disconnected.");

    // Trigger UI update if needed
    if (typeof updateControlPanel === 'function') {
        updateControlPanel();
    }
}


// --- Exported Public API Object ---
export const MPLib = {
    /**
     * Initializes or re-initializes the PeerJS connection.
     * @param {object} options - Configuration options.
     */
    initialize, // Expose initialize function

    /**
     * Broadcasts a payload to all connected peers using the gossip protocol.
     * @param {any} payload - The data payload to broadcast. Must be JSON-serializable.
     */
    broadcast: (payload) => {
        if (!payload) {
            logMessage("Broadcast payload cannot be empty.", 'warn');
            return;
        }
        if (!localPeerId || !peer || peer.destroyed) {
            logMessage("Cannot broadcast: Peer not initialized or connected.", 'warn');
            return;
        }
        // Wrap payload in the gossip message structure
        const message = {
            messageId: generateUniqueId(),
            originalSenderId: localPeerId,
            payload: payload,
            ttl: config.messageTTL // Use configured TTL
        };
        // logMessage(`Broadcasting msg ${message.messageId.slice(-4)}`, 'debug');
        broadcastInternal(message); // Use internal broadcast function
    },

    /**
     * Sends a direct message to a specific peer.
     * @param {string} targetPeerId - The ID of the recipient peer.
     * @param {any} payload - The data payload to send. Must be JSON-serializable.
     */
    sendDirect: (targetPeerId, payload) => {
        if (!targetPeerId || !payload) {
            logMessage("Direct send requires targetPeerId and payload.", 'warn');
            return;
        }
        if (!peer || peer.destroyed) {
            logMessage("Cannot send direct: Peer not initialized.", 'warn');
            return;
        }
        if (targetPeerId === localPeerId) {
            logMessage("Cannot send direct message to self.", 'warn');
            return;
        }

        const conn = connections.get(targetPeerId);
        if (conn && conn !== 'connecting' && conn.open) {
            try {
                // Direct messages don't use the gossip structure unless the app adds it
                conn.send(payload);
            } catch (e) {
                logMessage(`Error sending direct message to ${targetPeerId.slice(-6)}: ${e.message}`, 'error');
                removeConnection(targetPeerId); // Remove connection if send fails
            }
        } else {
            logMessage(`No open connection to ${targetPeerId.slice(-6)} for direct message. Status: ${conn || 'Not connected'}`, 'warn');
        }
    },

    /**
     * Disconnects from the network and resets the library state.
     */
    disconnect: () => {
        logMessage("Disconnecting and resetting state.", 'info');
        resetState();
    },

    // --- Read-only State Accessors (using getter syntax) ---

    /** Gets the local PeerJS ID, or null if not connected. */
    get localPeerId() { return localPeerId; },

    /** Gets the PeerJS ID of the current host, or null if not connected to a host or is the host. */
    get hostPeerId() { return hostPeerId; },

    /** Returns true if the local instance is currently acting as the host, false otherwise. */
    get isHost() { return isHost; },

    /**
     * Gets a Map of active connections. Keys are peer IDs, values are PeerJS DataConnection objects.
     * Note: Returns the internal Map directly for performance; do not modify it externally.
     * Consider returning a copy (`new Map(connections)`) if external modification is a risk.
     */
    get connections() { return connections; },

    /**
     * Returns a Set of peer IDs that we are currently attempting to establish an outgoing connection to.
     */
    get pendingConnections() { return pendingConnections; },

    /** Gets the current configuration object. */
    get configuration() { return { ...config }; }, // Return a shallow copy
};

// Make updateControlPanel globally available ONLY IF NEEDED (e.g., for simple examples)
// In a real application, UI updates should be handled via the callbacks (onPeerJoined, onPeerLeft, onStatusUpdate, etc.)
// Example: window.updateControlPanel = updateControlPanel; // Avoid if possible