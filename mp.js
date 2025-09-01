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

        if (!config.lobbyName) {
            config.onError('init', 'Lobby Name is required.');
            return;
        }

        // Sanitize lobby name to create a valid PeerJS ID
        const seedId = `sparksync-lobby-${config.lobbyName.replace(/[^a-zA-Z0-9-]/g, '-')}`;

        // First, try to BECOME the seed node for this lobby
        logMessage(`Attempting to become seed for lobby '${config.lobbyName}' with ID: ${seedId}`, 'info');
        peer = new Peer(seedId, { debug: config.debugLevel, key: API_KEY });

        setupPeerListeners(peer, seedId);
    }

    function setupPeerListeners(p, seedId) {
        p.on('open', (id) => {
            // This event fires when we successfully register with the signaling server.
            // If we get here with our desired seedId, it means WE are the seed.
            localPeerId = id;
            knownPeerIds.add(id);
            logMessage(`Successfully registered as seed node with ID: ${id}`, 'success');
            config.onConnected(id);
        });

        p.on('connection', (conn) => {
            logMessage(`Incoming connection from ${conn.peer}`, 'info');
            setupConnection(conn);
        });

        p.on('error', (err) => {
            if (err.type === 'unavailable-id') {
                // This means the seed ID is already taken, which is GOOD. It means the lobby exists.
                // We destroy the failed peer object and create a new, anonymous one to connect.
                logMessage(`Seed ID '${seedId}' is taken. Connecting to existing lobby.`, 'info');
                p.destroy(); // Clean up the failed peer

                peer = new Peer({ debug: config.debugLevel, key: API_KEY }); // Create anonymous peer
                peer.on('open', (id) => {
                    localPeerId = id;
                    knownPeerIds.add(id);
                    config.onConnected(id);
                    logMessage(`Connected with anonymous ID: ${id}. Now connecting to seed.`, 'info');
                    connectToPeer(seedId); // Connect to the seed node
                });
                // Set up standard listeners for the new anonymous peer
                peer.on('connection', (conn) => setupConnection(conn));
                peer.on('error', (e) => config.onError(e.type, e));
            } else {
                // Handle other errors
                logMessage(`PeerJS Error: ${err.type}`, 'error');
                config.onError(err.type, err);
            }
        });
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
