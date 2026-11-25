// Dual Cube Timer V6.4 - Serverless WebRTC P2P Engine (PeerJS + Auto-Reconnect)
(function (global) {
    const PEER_PREFIX = 'dct-v5-room-';
    const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 12000, 15000];
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
        connectionState: 'disconnected',
        myName: 'Player 1',
        oppName: 'Player 2',
        handlers: {},
        _connectTimer: null,
        _signalingTimer: null,
        _helloTimer: null,
        _retryTimer: null,
        _reconnectTimer: null,
        _reconnectGuardTimer: null,
        _reconnectAttempt: 0,
        _maxReconnectAttempts: RECONNECT_DELAYS.length,
        _hadMatchConnection: false,
        _manualClose: false,
        _welcomed: false,
        _visibilityBound: false,

        on(event, fn) {
            if (!this.handlers[event]) this.handlers[event] = [];
            if (!this.handlers[event].includes(fn)) {
                this.handlers[event].push(fn);
            }
        },

        off(event, fn) {
            if (!this.handlers[event]) return;
            this.handlers[event] = this.handlers[event].filter(h => h !== fn);
        },

        emit(event, data) {
            const list = this.handlers[event];
            if (!list || !list.length) return;
            list.forEach((fn) => {
                try { fn(data); } catch (e) {}
            });
        },

        _bindVisibilityListener() {
            if (this._visibilityBound || typeof document === 'undefined') return;
            this._visibilityBound = true;
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState !== 'visible') return;
                if (!this.enabled || this._manualClose || !this._hadMatchConnection) return;
                if (!this.conn || !this.conn.open || !this.connected) {
                    if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
                        try { this.peer.reconnect(); } catch (e) {}
                    }
                    this._reconnectAttempt = Math.min(this._reconnectAttempt, 0);
                    this.scheduleReconnect('Tab returned to foreground');
                }
            });
        },

        _setConnectionState(nextState, extra = {}) {
            this.connectionState = nextState;
            this.emit('connection-state', {
                state: nextState,
                attempt: this._reconnectAttempt,
                maxAttempts: this._maxReconnectAttempts,
                ...extra
            });
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
            this._bindVisibilityListener();
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
                const samePeerRejoining = this._hadMatchConnection && this.conn && connection.peer === this.conn.peer;
                const staleSocket = !this.conn || !this.conn.open || !this.connected;
                if (this.conn && this.conn.open && this.connected && !samePeerRejoining) {
                    connection.close();
                    return;
                }
                if (this.conn && this.conn !== connection && (staleSocket || samePeerRejoining)) {
                    try { this.conn.close(); } catch (e) {}
                }
                this.conn = connection;
                this.bindConnectionEvents();
            });

            this.peer.on('disconnected', () => {
                if (this.peer && !this.peer.destroyed && !this._manualClose) {
                    try { this.peer.reconnect(); } catch (e) {}
                    if (this._hadMatchConnection && !this.connected) {
                        this.scheduleReconnect('Signaling disconnected');
                    }
                }
            });

            this.peer.on('error', (err) => {
                clearTimeout(this._signalingTimer);
                if (this._hadMatchConnection && this.enabled && !this._manualClose) {
                    this.scheduleReconnect(err.message || 'Signaling error');
                } else {
                    this.emit('error', err.message || 'Connection error');
                }
            });
        },

        joinRoom(roomCode, guestName) {
            this.cleanup();
            this._bindVisibilityListener();
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
                        const iceState = this.conn && this.conn.peerConnection ? this.conn.peerConnection.iceConnectionState : '';
                        if (iceState === 'checking') {
                            this.emit('status', 'Negotiating peer-to-peer connection...');
                        } else if (iceState === 'failed' && !this.connected) {
                            clearTimeout(this._connectTimer);
                            if (this._hadMatchConnection) {
                                this.scheduleReconnect('ICE connection failed');
                            } else {
                                scheduleRetry('Network NAT blocked.');
                            }
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
                if (!this._hadMatchConnection) {
                    attemptConnect();
                }
            });

            this.peer.on('disconnected', () => {
                if (this.peer && !this.peer.destroyed && !this._manualClose) {
                    try { this.peer.reconnect(); } catch (e) {}
                    if (this._hadMatchConnection && !this.connected) {
                        this.scheduleReconnect('Signaling disconnected');
                    }
                }
            });

            this.peer.on('error', (err) => {
                clearTimeout(this._signalingTimer);
                clearTimeout(this._connectTimer);
                if (this._hadMatchConnection) {
                    this.scheduleReconnect(err.message || 'Peer error');
                    return;
                }
                if (err.type === 'peer-unavailable') {
                    scheduleRetry(`Room ${this.roomCode} not ready.`);
                } else {
                    failAll(err.message || 'Could not join room. Check the code or host status.');
                }
            });
        },

        scheduleReconnect(reason = 'Connection interrupted') {
            if (!this.enabled || this._manualClose || !this._hadMatchConnection || this.connected) return;
            if (this._reconnectTimer) return;

            if (this._reconnectAttempt >= this._maxReconnectAttempts) {
                this._setConnectionState('disconnected', { exhausted: true, reason });
                return;
            }

            const delayMs = RECONNECT_DELAYS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)];
            this._reconnectAttempt++;
            this._setConnectionState('reconnecting', { delayMs, reason });

            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                if (!this.enabled || this._manualClose || this.connected) return;

                if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
                    try { this.peer.reconnect(); } catch (e) {}
                }

                if (!this.isHost && this.peer && !this.peer.destroyed) {
                    const redial = () => {
                        if (!this.enabled || this._manualClose || this.connected) return;
                        if (this.conn) {
                            try { this.conn.close(); } catch (e) {}
                        }
                        this.conn = this.peer.connect(PEER_PREFIX + this.roomCode, { reliable: true });
                        this.bindConnectionEvents();
                        clearTimeout(this._reconnectGuardTimer);
                        this._reconnectGuardTimer = setTimeout(() => {
                            if (this.enabled && !this._manualClose && !this.connected) {
                                this.scheduleReconnect('Reconnect attempt timed out');
                            }
                        }, 5500);
                    };

                    if (this.peer.open) {
                        redial();
                    } else {
                        this.peer.once('open', redial);
                    }
                } else if (this.isHost) {
                    // Host waits briefly for guest redial before advancing backoff
                    clearTimeout(this._reconnectGuardTimer);
                    this._reconnectGuardTimer = setTimeout(() => {
                        if (this.enabled && !this._manualClose && !this.connected) {
                            this.scheduleReconnect('Waiting for guest reconnect');
                        }
                    }, 5500);
                }
            }, delayMs);
        },

        bindConnectionEvents() {
            const activeConn = this.conn;
            if (!activeConn) return;

            activeConn.on('open', () => {
                if (this.conn !== activeConn) return;
                clearTimeout(this._connectTimer);
                clearTimeout(this._retryTimer);
                clearTimeout(this._reconnectTimer);
                this._reconnectTimer = null;
                clearTimeout(this._reconnectGuardTimer);
                const wasReconnecting = this.connectionState === 'reconnecting' || (this._hadMatchConnection && this._reconnectAttempt > 0);
                this.connected = true;
                this._hadMatchConnection = true;
                this._reconnectAttempt = 0;
                this.emit('status', 'Connected! Syncing players...');
                this._setConnectionState(wasReconnecting ? 'reconnected' : 'connected');

                if (!this.isHost) {
                    let helloAttempts = 0;
                    const sendHandshake = () => {
                        if (!this.connected || !this.conn || !this.conn.open) {
                            clearInterval(this._helloTimer);
                            return;
                        }
                        if (wasReconnecting && this._welcomed) {
                            this.send({ type: 'REJOIN', name: this.myName });
                            clearInterval(this._helloTimer);
                            return;
                        }
                        if (this._welcomed) {
                            clearInterval(this._helloTimer);
                            return;
                        }
                        helloAttempts++;
                        this.send({ type: 'HELLO', name: this.myName });
                        if (helloAttempts >= 15) clearInterval(this._helloTimer);
                    };
                    sendHandshake();
                    clearInterval(this._helloTimer);
                    this._helloTimer = setInterval(sendHandshake, 500);
                }
            });

            activeConn.on('data', (msg) => {
                if (this.conn !== activeConn || !msg || !msg.type) return;
                if (msg.type === 'WELCOME' || msg.type === 'REJOIN_ACK') {
                    this._welcomed = true;
                    clearInterval(this._helloTimer);
                }
                this.emit('message', msg);
            });

            activeConn.on('close', () => {
                if (this.conn !== activeConn) return;
                const wasConnected = this.connected;
                this.connected = false;
                clearInterval(this._helloTimer);
                if (this._manualClose) return;
                if (wasConnected || this._hadMatchConnection) {
                    this.emit('disconnected');
                    this.scheduleReconnect('Peer channel closed');
                }
            });

            activeConn.on('error', () => {
                if (this.conn !== activeConn) return;
                if (!this.connected && !this._hadMatchConnection) {
                    this.emit('error', 'Peer connection error');
                } else if (!this._manualClose && this._hadMatchConnection) {
                    this.connected = false;
                    this.scheduleReconnect('Peer connection error');
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
            this._manualClose = true;
            clearTimeout(this._connectTimer);
            clearTimeout(this._signalingTimer);
            clearTimeout(this._retryTimer);
            clearTimeout(this._reconnectTimer);
            clearTimeout(this._reconnectGuardTimer);
            this._reconnectTimer = null;
            this._reconnectAttempt = 0;
            this._hadMatchConnection = false;
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
            this._setConnectionState('disconnected');
            this._manualClose = false;
        }
    };

    global.DCT_P2P = P2P;
})(window);
