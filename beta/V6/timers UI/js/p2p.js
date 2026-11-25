// Dual Cube Timer V5 - Serverless WebRTC P2P Engine (PeerJS)
(function (global) {
    const PEER_PREFIX = 'dct-v5-room-';
    const ICE_CONFIG = {
        iceCandidatePoolSize: 10,
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            {
                urls: [
                    'turn:openrelay.metered.ca:80',
                    'turn:openrelay.metered.ca:80?transport=tcp',
                    'turn:openrelay.metered.ca:443',
                    'turn:openrelay.metered.ca:443?transport=tcp',
                    'turns:openrelay.metered.ca:443?transport=tcp'
                ],
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
        _connectTimer: null,
        _signalingTimer: null,
        _helloTimer: null,
        _retryTimer: null,
        _welcomed: false,

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

            this.emit('status', 'Creating room on signaling server...');
            this.peer = new Peer(peerId, { debug: 0, config: ICE_CONFIG });

            this._signalingTimer = setTimeout(() => {
                if (this.peer && !this.peer.open && !this.peer.destroyed) {
                    this.emit('error', 'Could not reach PeerJS signaling server. Check your internet/firewall and try again.');
                    this.cleanup();
                }
            }, 12000);

            this.peer.on('open', () => {
                clearTimeout(this._signalingTimer);
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

            this.peer.on('disconnected', () => {
                if (this.peer && !this.peer.destroyed) {
                    this.peer.reconnect();
                }
            });

            this.peer.on('error', (err) => {
                clearTimeout(this._signalingTimer);
                this.emit('error', err.message || 'Connection error');
            });
        },

        joinRoom(roomCode, guestName) {
            this.cleanup();
            this.enabled = true;
            this.isHost = false;
            this._welcomed = false;
            this.roomCode = roomCode.trim().toUpperCase();
            this.myName = (guestName || 'Player 2').trim() || 'Player 2';

            if (typeof Peer === 'undefined') {
                this.emit('error', 'PeerJS failed to load. Check your internet connection.');
                return;
            }

            this.emit('status', 'Connecting to signaling server...');
            this.peer = new Peer(undefined, { debug: 0, config: ICE_CONFIG });

            const maxRetries = 3;
            let retryCount = 0;
            let finished = false;

            const failAll = (msg) => {
                if (finished) return;
                finished = true;
                this.cleanup();
                this.emit('error', msg);
            };

            const scheduleRetry = (reason) => {
                if (finished || !this.peer || this.peer.destroyed || this.connected) return;
                if (retryCount < maxRetries) {
                    retryCount++;
                    this.emit('status', `${reason} Retrying (${retryCount}/${maxRetries})...`);
                    if (this.conn) {
                        try { this.conn.close(); } catch (e) {}
                        this.conn = null;
                    }
                    clearTimeout(this._retryTimer);
                    this._retryTimer = setTimeout(attemptConnect, 1800);
                } else {
                    failAll('Could not connect to host. Make sure the room code is right, the host tab is open, and try again.');
                }
            };

            const attemptConnect = () => {
                if (finished || !this.peer || this.peer.destroyed || this.connected) return;
                const attemptLabel = retryCount > 0 ? ` (Attempt ${retryCount + 1}/${maxRetries + 1})` : '';
                this.emit('status', `Connecting to room ${this.roomCode}${attemptLabel}...`);
                this.conn = this.peer.connect(PEER_PREFIX + this.roomCode, { reliable: true });
                this.bindConnectionEvents();

                clearTimeout(this._connectTimer);
                this._connectTimer = setTimeout(() => {
                    if (!this.connected && !finished) {
                        scheduleRetry('Connection timed out.');
                    }
                }, 9000);

                if (this.conn && this.conn.peerConnection) {
                    this.conn.peerConnection.oniceconnectionstatechange = () => {
                        const state = this.conn && this.conn.peerConnection ? this.conn.peerConnection.iceConnectionState : '';
                        if (state === 'checking') {
                            this.emit('status', 'Negotiating peer-to-peer connection...');
                        } else if (state === 'failed' && !this.connected) {
                            clearTimeout(this._connectTimer);
                            scheduleRetry('Network NAT blocked.');
                        }
                    };
                }
            };

            this._signalingTimer = setTimeout(() => {
                if (this.peer && !this.peer.open && !finished) {
                    failAll('Could not reach signaling server. Check your internet connection.');
                }
            }, 12000);

            this.peer.on('open', () => {
                clearTimeout(this._signalingTimer);
                attemptConnect();
            });

            this.peer.on('error', (err) => {
                clearTimeout(this._signalingTimer);
                clearTimeout(this._connectTimer);
                if (err.type === 'peer-unavailable') {
                    scheduleRetry(`Room ${this.roomCode} not ready.`);
                } else {
                    failAll(err.message || 'Could not join room. Check the code or host status.');
                }
            });
        },

        bindConnectionEvents() {
            if (!this.conn) return;

            this.conn.on('open', () => {
                clearTimeout(this._connectTimer);
                clearTimeout(this._retryTimer);
                this.connected = true;
                this.emit('status', 'Connected! Syncing players...');
                if (!this.isHost) {
                    let helloAttempts = 0;
                    const sendHello = () => {
                        if (!this.connected || this._welcomed || !this.conn || !this.conn.open) {
                            clearInterval(this._helloTimer);
                            return;
                        }
                        helloAttempts++;
                        this.send({ type: 'HELLO', name: this.myName });
                        if (helloAttempts >= 15) clearInterval(this._helloTimer);
                    };
                    sendHello();
                    clearInterval(this._helloTimer);
                    this._helloTimer = setInterval(sendHello, 500);
                }
            });

            this.conn.on('data', (msg) => {
                if (!msg || !msg.type) return;
                if (msg.type === 'WELCOME') {
                    this._welcomed = true;
                    clearInterval(this._helloTimer);
                }
                this.emit('message', msg);
            });

            this.conn.on('close', () => {
                const wasConnected = this.connected;
                this.connected = false;
                clearInterval(this._helloTimer);
                if (wasConnected) {
                    this.emit('disconnected');
                }
            });

            this.conn.on('error', () => {
                if (!this.connected) {
                    this.emit('error', 'Peer connection error');
                }
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
            clearTimeout(this._connectTimer);
            clearTimeout(this._signalingTimer);
            clearTimeout(this._retryTimer);
            clearInterval(this._helloTimer);
            this._welcomed = false;
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
