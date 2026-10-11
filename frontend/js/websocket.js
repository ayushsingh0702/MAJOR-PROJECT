/**
 * websocket.js
 *
 * Spring Boot WebRTC Signaling Client.
 * Exchanges SDP Offers, SDP Answers, ICE candidates, and peer lifecycle events.
 *
 * Key Features:
 * - Promise-based connect() that resolves ONLY after WebSocket OPEN + REGISTER + REGISTERED
 * - Outgoing message queue: NEVER drops offers, answers, or ICE candidates if socket is connecting
 * - Strict deviceId and targetDeviceId routing
 * - Rich diagnostic logging: [WS], [WebRTC], [ICE]
 * - Exponential backoff auto-reconnect and heartbeat keepalive
 */

(function () {
    'use strict';

    class SignalingClient {
        constructor(options = {}) {
            this.url = options.url || window.WomenSafetyConfig.getSignalingUrl();
            this.role = (options.role || 'CLIENT').toUpperCase(); // 'PHONE' or 'DASHBOARD'
            this.sessionId = options.sessionId || window.WomenSafetyConfig.getDefaultSessionId();
            this.deviceId = options.deviceId || (this.role.toLowerCase() + '-' + Math.random().toString(36).substring(2, 8));

            this.ws = null;
            this.isConnected = false;
            this.isRegistered = false;
            this.reconnectAttempts = 0;
            this.maxReconnectAttempts = 15;
            this.reconnectTimer = null;
            this.heartbeatTimer = null;

            // Connection promise tracking
            this.connectPromise = null;
            this.connectResolve = null;
            this.connectReject = null;
            this.connectTimeoutTimer = null;

            // Outgoing queue to prevent dropping any message before WebSocket is OPEN & REGISTERED
            this.outgoingQueue = [];

            // Callback hooks
            this.onOffer = null;
            this.onAnswer = null;
            this.onIceCandidate = null;
            this.onPeerConnected = null;
            this.onPeerDisconnected = null;
            this.onRequestOffer = null;
            this.onStatusChange = null;
            this.onError = null;
            this.onReady = null;
        }

        /**
         * Connect to Spring Boot signaling server.
         * Returns a Promise that resolves ONLY when:
         * 1. WebSocket is OPEN
         * 2. REGISTER has been sent
         * 3. REGISTERED acknowledgment is received from Spring Boot
         */
        connect() {
            // If already connected and registered, resolve immediately
            if (this.isConnected && this.isRegistered && this.ws && this.ws.readyState === WebSocket.OPEN) {
                return Promise.resolve(this);
            }

            // If a connection attempt is already in flight, return the existing promise
            if (this.connectPromise) {
                return this.connectPromise;
            }

            this.updateStatus('Connecting...');
            console.log(`[WS] Connecting to signaling server... (${this.url})`);

            this.connectPromise = new Promise((resolve, reject) => {
                this.connectResolve = resolve;
                this.connectReject = reject;

                // Safety timeout: 15 seconds
                this.connectTimeoutTimer = setTimeout(() => {
                    if (!this.isRegistered) {
                        const timeoutErr = new Error(`[WS] Signaling connection timed out after 15s to ${this.url}`);
                        console.error(timeoutErr.message);
                        this.cleanupPendingPromise(timeoutErr);
                    }
                }, 15000);

                try {
                    this.ws = new WebSocket(this.url);
                } catch (err) {
                    console.error('[WS] Failed to instantiate WebSocket:', err);
                    this.updateStatus('Connection Failed');
                    this.cleanupPendingPromise(err);
                    this.scheduleReconnect();
                    return;
                }

                this.ws.onopen = () => {
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    console.log('[WS] WebSocket OPEN');
                    this.updateStatus('Connected to Signaling Server');

                    // Immediately dispatch REGISTER payload
                    this.register();

                    // Start ping-pong heartbeat
                    this.startHeartbeat();
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onerror = (err) => {
                    console.warn('[WS] WebSocket error encountered:', err);
                    if (this.onError) {
                        this.onError(err);
                    }
                };

                this.ws.onclose = (event) => {
                    console.log(`[WS] Connection closed (code: ${event.code}, reason: ${event.reason || 'None'})`);
                    this.isConnected = false;
                    this.isRegistered = false;
                    this.stopHeartbeat();
                    this.updateStatus('Connection Lost');

                    if (this.connectReject) {
                        this.cleanupPendingPromise(new Error(`[WS] WebSocket closed prematurely (code: ${event.code})`));
                    }

                    this.scheduleReconnect();
                };
            });

            return this.connectPromise;
        }

        cleanupPendingPromise(err = null) {
            if (this.connectTimeoutTimer) {
                clearTimeout(this.connectTimeoutTimer);
                this.connectTimeoutTimer = null;
            }
            if (err && this.connectReject) {
                this.connectReject(err);
            }
            this.connectPromise = null;
            this.connectResolve = null;
            this.connectReject = null;
        }

        /**
         * Wait until signaling is connected and registered.
         */
        waitUntilReady() {
            if (this.isConnected && this.isRegistered && this.ws && this.ws.readyState === WebSocket.OPEN) {
                return Promise.resolve(this);
            }
            return this.connect();
        }

        /**
         * Send registration payload to Spring Boot backend
         */
        register() {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                console.warn('[WS] Cannot send REGISTER: WebSocket is not in OPEN state');
                return;
            }

            const registerPayload = {
                type: 'REGISTER',
                sessionId: this.sessionId,
                role: this.role,
                deviceId: this.deviceId
            };

            // Direct send for registration message
            this.ws.send(JSON.stringify(registerPayload));
            console.log('[WS] REGISTER sent');
        }

        /**
         * Handle incoming signaling messages from Spring Boot backend
         */
        handleMessage(rawData) {
            try {
                const message = JSON.parse(rawData);
                const type = (message.type || '').toUpperCase();

                switch (type) {
                    case 'REGISTERED':
                        this.isRegistered = true;
                        console.log(`[WS] REGISTERED (confirmed by server for deviceId: ${message.deviceId || this.deviceId})`);

                        // Clear timeout and resolve connect promise
                        if (this.connectTimeoutTimer) {
                            clearTimeout(this.connectTimeoutTimer);
                            this.connectTimeoutTimer = null;
                        }
                        if (this.connectResolve) {
                            this.connectResolve(this);
                            this.connectPromise = null;
                            this.connectResolve = null;
                            this.connectReject = null;
                        }

                        // Flush any messages that were queued while socket was connecting
                        this.flushOutgoingQueue();

                        if (this.onReady) {
                            this.onReady(this);
                        }
                        break;

                    case 'OFFER':
                        console.log(`[WebRTC] OFFER received from ${message.deviceId || 'remote-peer'}`);
                        if (this.onOffer) {
                            this.onOffer(message.payload, message.deviceId, message.sessionId);
                        }
                        break;

                    case 'ANSWER':
                        console.log('[WebRTC] ANSWER received');
                        if (this.onAnswer) {
                            this.onAnswer(message.payload, message.deviceId, message.sessionId);
                        }
                        break;

                    case 'ICE_CANDIDATE':
                        console.log('[ICE] Candidate received');
                        if (this.onIceCandidate) {
                            this.onIceCandidate(message.payload, message.deviceId, message.sessionId);
                        }
                        break;

                    case 'REQUEST_OFFER':
                        console.log('[WS] Server requested fresh SDP offer for peer:', message.deviceId || 'dashboard');
                        if (this.onRequestOffer) {
                            this.onRequestOffer(message.deviceId);
                        }
                        break;

                    case 'PEER_CONNECTED': {
                        const peerId = (message.payload && message.payload.deviceId) || message.deviceId || 'unknown';
                        console.log(`[WS] Peer connected: ${peerId}`);
                        if (this.onPeerConnected) {
                            this.onPeerConnected(message.payload || { deviceId: message.deviceId, role: message.role });
                        }
                        break;
                    }

                    case 'PEER_DISCONNECTED':
                    case 'STREAM_STOPPED': {
                        const disconnectedId = (message.payload && message.payload.deviceId) || message.deviceId || 'unknown';
                        console.log(`[WS] Peer disconnected: ${disconnectedId}`);
                        if (this.onPeerDisconnected) {
                            this.onPeerDisconnected(message.payload || { deviceId: message.deviceId, role: message.role });
                        }
                        break;
                    }

                    case 'PONG':
                        // Heartbeat reply
                        break;

                    case 'ERROR':
                        console.error('[WS] Server error response:', message.payload);
                        if (this.onError) {
                            this.onError(message.payload);
                        }
                        break;

                    default:
                        console.log('[WS] Unhandled message type:', type, message);
                        break;
                }
            } catch (err) {
                console.error('[WS] Malformed JSON message received:', err, rawData);
            }
        }

        /**
         * Send SDP Offer
         */
        sendOffer(offer, targetDeviceId = null) {
            const message = {
                type: 'OFFER',
                sessionId: this.sessionId,
                role: this.role,
                deviceId: this.deviceId,
                targetDeviceId: targetDeviceId,
                payload: offer
            };
            this.sendRaw(message);
            console.log(`[WebRTC] OFFER sent${targetDeviceId ? ' to ' + targetDeviceId : ''}`);
        }

        /**
         * Send SDP Answer
         */
        sendAnswer(answer, targetDeviceId = null) {
            const message = {
                type: 'ANSWER',
                sessionId: this.sessionId,
                role: this.role,
                deviceId: this.deviceId,
                targetDeviceId: targetDeviceId,
                payload: answer
            };
            this.sendRaw(message);
            console.log(`[WebRTC] ANSWER sent${targetDeviceId ? ' to ' + targetDeviceId : ''}`);
        }

        /**
         * Send ICE Candidate
         */
        sendIceCandidate(candidate, targetDeviceId = null) {
            const message = {
                type: 'ICE_CANDIDATE',
                sessionId: this.sessionId,
                role: this.role,
                deviceId: this.deviceId,
                targetDeviceId: targetDeviceId,
                payload: candidate
            };
            this.sendRaw(message);
            console.log(`[ICE] Candidate sent${targetDeviceId ? ' to ' + targetDeviceId : ''}`);
        }

        /**
         * Send Stream Stopped notification
         */
        sendStreamStopped() {
            const message = {
                type: 'STREAM_STOPPED',
                sessionId: this.sessionId,
                role: this.role,
                deviceId: this.deviceId,
                payload: { reason: 'User clicked stop camera' }
            };
            this.sendRaw(message);
        }

        /**
         * Send or queue raw JSON message.
         * If the WebSocket is NOT in OPEN state, or client is not yet REGISTERED,
         * the message is safely stored in outgoingQueue and dispatched upon registration.
         */
        sendRaw(obj) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN && (this.isRegistered || obj.type === 'REGISTER')) {
                try {
                    this.ws.send(JSON.stringify(obj));
                    return true;
                } catch (e) {
                    console.error('[WS] Error writing to WebSocket:', e);
                    this.outgoingQueue.push(obj);
                    return false;
                }
            } else {
                console.log(`[WS] Message queued (WebSocket not yet open/registered): ${obj.type}`);
                this.outgoingQueue.push(obj);
                return true;
            }
        }

        /**
         * Flush queued messages in FIFO order once connection & registration complete
         */
        flushOutgoingQueue() {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isRegistered) {
                return;
            }

            if (this.outgoingQueue.length > 0) {
                console.log(`[WS] Flushing ${this.outgoingQueue.length} queued message(s)...`);
                while (this.outgoingQueue.length > 0) {
                    const queuedMsg = this.outgoingQueue.shift();
                    try {
                        this.ws.send(JSON.stringify(queuedMsg));
                        console.log(`[WS] Dispatched queued message: ${queuedMsg.type}`);
                    } catch (e) {
                        console.error(`[WS] Failed to dispatch queued message (${queuedMsg.type}):`, e);
                        // Put back at head and abort flush
                        this.outgoingQueue.unshift(queuedMsg);
                        break;
                    }
                }
            }
        }

        /**
         * Reconnect with exponential backoff
         */
        scheduleReconnect() {
            if (this.reconnectTimer) return;
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.warn('[WS] Maximum reconnection attempts reached.');
                this.updateStatus('Connection Lost');
                return;
            }

            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
            this.updateStatus('Reconnecting...');
            console.log(`[WS] Scheduling reconnect attempt #${this.reconnectAttempts} in ${Math.round(delay)}ms`);

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                // Re-evaluate URL dynamically in case changed
                this.url = window.WomenSafetyConfig ? window.WomenSafetyConfig.getSignalingUrl() : this.url;
                this.connect().catch(err => {
                    console.warn('[WS] Reconnect attempt failed:', err.message);
                });
            }, delay);
        }

        startHeartbeat() {
            this.stopHeartbeat();
            this.heartbeatTimer = setInterval(() => {
                if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN && this.isRegistered) {
                    this.ws.send(JSON.stringify({
                        type: 'PING',
                        sessionId: this.sessionId,
                        role: this.role,
                        deviceId: this.deviceId
                    }));
                }
            }, 25000);
        }

        stopHeartbeat() {
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }
        }

        updateStatus(statusText) {
            if (this.onStatusChange) {
                this.onStatusChange(statusText);
            }
        }

        disconnect() {
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            this.stopHeartbeat();
            this.cleanupPendingPromise();

            if (this.ws) {
                this.ws.onclose = null;
                this.ws.close();
                this.ws = null;
            }
            this.isConnected = false;
            this.isRegistered = false;
            this.outgoingQueue = [];
        }
    }

    // Export class to window
    window.SignalingClient = SignalingClient;
})();
