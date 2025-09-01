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
        if (!peer || peer.destroyed) return;
        // Ask the signaling server for a list of all peers for our API key
        fetch(`https://0.peerjs.com/peerjs/peers`)
            .then(res => res.json())
            .then(peerIds => {
                peerIds.forEach(id => {
                    if (id !== localPeerId && !connections.has(id) && !pendingConnections.has(id)) {
                        connectToPeer(id);
                    }
                });
            })
            .catch(err => config.onError('discovery', err));

        // Periodically rediscover to find new peers
        setTimeout(discoverPeers, 5000);
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

        conn.on('data', (data) => {
            config.onDataReceived(remotePeerId, data);
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
