// Dual Cube Timer V5 - Serverless WebRTC P2P Engine (PeerJS)
(function (global) {
    const PEER_PREFIX = 'dct-v5-room-';
    const ICE_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turns:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ]
    };

    function generateRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 5; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        return code;
    }

    const P2P = {
        enabled: false,
        isHost: false,
        roomCode: null,
        peer: null,
        conn: null,
        connected: false,
        myName: 'Player 1',
        oppName: 'Player 2',
        handlers: {},

        on(event, fn) {
            this.handlers[event] = fn;
        },

        emit(event, data) {
            if (this.handlers[event]) this.handlers[event](data);
        },

        getRoomFromURL() {
            try {
                const params = new URLSearchParams(window.location.search);
                const r = params.get('room');
                return r ? r.trim().toUpperCase() : null;
            } catch (e) {
                return null;
            }
        },

        buildInviteURL(code) {
            const url = new URL(window.location.href);
            url.searchParams.set('room', code);
            return url.toString();
        },

        createRoom(hostName) {
            this.cleanup();
            this.enabled = true;
            this.isHost = true;
            this.myName = (hostName || 'Player 1').trim() || 'Player 1';
            this.roomCode = generateRoomCode();
            const peerId = PEER_PREFIX + this.roomCode;

            if (typeof Peer === 'undefined') {
                this.emit('error', 'PeerJS failed to load. Check your internet connection.');
                return;
            }

            this.peer = new Peer(peerId, { debug: 0, config: ICE_CONFIG });

            this.peer.on('open', () => {
                this.emit('room-created', {
                    roomCode: this.roomCode,
                    inviteUrl: this.buildInviteURL(this.roomCode)
                });
            });

            this.peer.on('connection', (connection) => {
                if (this.conn && this.conn.open) {
                    connection.close();
                    return;
                }
                this.conn = connection;
                this.bindConnectionEvents();
            });

            this.peer.on('error', (err) => {
                this.emit('error', err.message || 'Connection error');
            });
        },

        joinRoom(roomCode, guestName) {
            this.cleanup();
            this.enabled = true;
            this.isHost = false;
            this.roomCode = roomCode.trim().toUpperCase();
            this.myName = (guestName || 'Player 2').trim() || 'Player 2';

            if (typeof Peer === 'undefined') {
                this.emit('error', 'PeerJS failed to load. Check your internet connection.');
                return;
            }

            this.peer = new Peer(undefined, { debug: 0, config: ICE_CONFIG });

            this.peer.on('open', () => {
                this.conn = this.peer.connect(PEER_PREFIX + this.roomCode, { reliable: true });
                this.bindConnectionEvents();
            });

            this.peer.on('error', (err) => {
                if (err.type === 'peer-unavailable') {
                    this.emit('error', 'Room not found or host is offline. Make sure the host tab is still open!');
                } else {
                    this.emit('error', err.message || 'Could not join room. Check the code or host status.');
                }
            });
        },

        bindConnectionEvents() {
            if (!this.conn) return;

            this.conn.on('open', () => {
                this.connected = true;
                if (!this.isHost) {
                    this.send({ type: 'HELLO', name: this.myName });
                }
            });

            this.conn.on('data', (msg) => {
                if (!msg || !msg.type) return;
                this.emit('message', msg);
            });

            this.conn.on('close', () => {
                this.connected = false;
                this.emit('disconnected');
            });

            this.conn.on('error', () => {
                this.emit('error', 'Peer connection error');
            });
        },

        send(payload) {
            if (this.enabled && this.conn && this.conn.open) {
                try {
                    this.conn.send(payload);
                } catch (e) {
                    // Ignore transient send errors
                }
            }
        },

        cleanup() {
            this.connected = false;
            if (this.conn) {
                try { this.conn.close(); } catch (e) {}
                this.conn = null;
            }
            if (this.peer) {
                try { this.peer.destroy(); } catch (e) {}
                this.peer = null;
            }
            this.enabled = false;
        }
    };

    global.DCT_P2P = P2P;
})(window);
