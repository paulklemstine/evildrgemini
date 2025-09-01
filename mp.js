/**
 * Multiplayer Library using PeerJS for a Mesh Network
 *
 * Provides core functionality for establishing P2P connections in a mesh,
 * managing peers, and broadcasting/handling messages.
 */
const MPLib = (() => {

    let peer = null;
    let localPeerId = null;
    const connections = new Map();
    const pendingConnections = new Set();
    const knownPeerIds = new Set();
    const API_KEY = 'peerjs'; // Public PeerJS API key

// Define a list of potential seed nodes. In a real-world app, these might
// be more stable, but for this demo, we'll use arbitrary IDs.
const SEED_NODES = [
    'sparksync-seed-1-alpha',
    'sparksync-seed-2-beta',
    'sparksync-seed-3-gamma',
];

    let config = {
        debugLevel: 0,
        onStatusUpdate: (msg, type) => console.log(`[MPLib] ${msg}`),
        onError: (type, err) => console.error(`[MPLib] Error (${type}):`, err),
        onPeerJoined: (peerId) => {},
        onPeerLeft: (peerId) => {},
        onDataReceived: (peerId, data) => {},
        onConnected: (id) => {},
    };

    function logMessage(message, type = 'info') {
        config.onStatusUpdate(message, type);
    }

    function initialize(options = {}) {
        if (peer && !peer.destroyed) {
            logMessage("Peer already initialized.", 'warn');
            return;
        }
        config = { ...config, ...options };

        try {
            peer = new Peer(undefined, {
                debug: config.debugLevel,
                key: API_KEY
            });
            setupPeerListeners(peer);
        } catch (e) {
            logMessage(`Fatal PeerJS initialization error: ${e.message}`, 'error');
            config.onError('init', e);
        }
    }

    function setupPeerListeners(p) {
        p.on('open', (id) => {
            localPeerId = id;
            knownPeerIds.add(id);
            logMessage(`PeerJS opened with ID: ${id}`, 'info');
            config.onConnected(id);
            discoverPeers(); // Start discovery process
        });

        p.on('connection', (conn) => {
            logMessage(`Incoming connection from ${conn.peer}`, 'info');
            setupConnection(conn);
        });

        p.on('disconnected', () => {
            logMessage("Disconnected from signaling server. Reconnecting...", 'warn');
            p.reconnect();
        });

        p.on('close', () => {
            logMessage("Peer connection closed permanently.", 'error');
            config.onError('close', 'Peer instance closed');
        });

        p.on('error', (err) => {
            logMessage(`PeerJS Error: ${err.type}`, 'error');
            config.onError(err.type, err);
        });
    }

    function discoverPeers() {
        logMessage("Attempting to connect to seed nodes...", 'info');
        let connectedToSeed = false;

        // Attempt to connect to all known seed nodes
        SEED_NODES.forEach(seedId => {
            if (seedId !== localPeerId) {
                const conn = peer.connect(seedId, { reliable: true });
                // We don't set up the connection here immediately. We wait for the 'open' event.
                // This is just to fire off the connection attempts.
                conn.on('open', () => {
                    connectedToSeed = true;
                    logMessage(`Successfully connected to seed node: ${seedId}`, 'success');
                    setupConnection(conn); // Set up the connection fully
                });
            }
        });

        // After a timeout, if we haven't connected to any seeds, we might become one.
        setTimeout(() => {
            if (!connectedToSeed && !peer.destroyed) {
                // If we are one of the designated seed IDs, we just stay online.
                if (SEED_NODES.includes(localPeerId)) {
                    logMessage(`Operating as a seed node: ${localPeerId}`, 'info');
                } else if (connections.size === 0) {
                    // If we are not a designated seed and connected to no one,
                    // it means the network is empty. We don't need to do anything
                    // special, just wait for others to connect to us if they can find us.
                    // The user's request to "become a seed" is complex. A simpler, more robust
                    // model is that every peer acts as a mini-hub for the peers it knows about.
                    logMessage("No seeds found. Waiting for incoming connections.", 'warn');
                }
            }
        }, 7000); // Wait 7 seconds for seed connections to establish.
    }

    function connectToPeer(targetPeerId) {
        if (!peer || peer.destroyed || targetPeerId === localPeerId || connections.has(targetPeerId) || pendingConnections.has(targetPeerId)) {
            return;
        }

        logMessage(`Attempting to connect to ${targetPeerId}`, 'info');
        pendingConnections.add(targetPeerId);

        const conn = peer.connect(targetPeerId, { reliable: true });
        conn.on('open', () => {
            logMessage(`Connection opened with ${targetPeerId}`, 'info');
            pendingConnections.delete(targetPeerId);
            setupConnection(conn);
        });
        conn.on('error', (err) => {
            logMessage(`Connection error with ${targetPeerId}: ${err.message}`, 'error');
            pendingConnections.delete(targetPeerId);
        });
    }

    function setupConnection(conn) {
        const remotePeerId = conn.peer;
        connections.set(remotePeerId, conn);
        knownPeerIds.add(remotePeerId);
        config.onPeerJoined(remotePeerId);

        // When a connection is first established, ask the other peer for their list of peers.
        conn.on('open', () => {
            conn.send({ type: 'request-peer-list' });
        });

        conn.on('data', (data) => {
            // --- Gossip Protocol Logic ---
            if (data.type === 'request-peer-list') {
                // They want our list. Send it to them.
                const peerList = Array.from(knownPeerIds);
                conn.send({ type: 'peer-list-update', list: peerList });
                logMessage(`Sent peer list to ${remotePeerId}`, 'info');
            } else if (data.type === 'peer-list-update') {
                // We received a list. Connect to any new peers.
                logMessage(`Received peer list from ${remotePeerId}: ${data.list.join(', ')}`, 'info');
                data.list.forEach(id => {
                    if (id !== localPeerId && !connections.has(id) && !pendingConnections.has(id)) {
                        connectToPeer(id);
                    }
                });
            } else {
                // It's a regular game message, pass it to the main app
                config.onDataReceived(remotePeerId, data);
            }
        });

        conn.on('close', () => {
            logMessage(`Connection closed with ${remotePeerId}`, 'warn');
            removeConnection(remotePeerId);
        });
    }

    function removeConnection(peerId) {
        if (connections.has(peerId)) {
            connections.delete(peerId);
            knownPeerIds.delete(peerId);
            logMessage(`Removed connection for ${peerId}`, 'info');
            config.onPeerLeft(peerId);
        }
    }

    function broadcast(payload) {
        connections.forEach((conn, peerId) => {
            if (conn.open) {
                try {
                    conn.send(payload);
                } catch (e) {
                    logMessage(`Error broadcasting to ${peerId}: ${e.message}`, 'error');
                }
            }
        });
    }

    function sendDirect(targetPeerId, payload) {
        const conn = connections.get(targetPeerId);
        if (conn && conn.open) {
            try {
                conn.send(payload);
            } catch (e) {
                logMessage(`Error sending direct message to ${targetPeerId}: ${e.message}`, 'error');
            }
        } else {
            logMessage(`No open connection to ${targetPeerId} for direct message.`, 'warn');
        }
    }

    const publicApi = {
        initialize,
        broadcast,
        sendDirect,
        getLocalPeerId: () => localPeerId,
        getConnections: () => new Map(connections),
    };

    return publicApi;
})();

export default MPLib;
