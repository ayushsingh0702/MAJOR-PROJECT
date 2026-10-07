/**
 * websocket.js
 * 
 * Spring Boot WebRTC Signaling Client.
 * Exchanges SDP Offers, SDP Answers, ICE candidates, and peer lifecycle events.
 * Handles automatic reconnects, heartbeats, and status indicators.
 */

(function () {
    'use strict';

    class SignalingClient {
        constructor(options = {}) {
            this.url = options.url || window.WomenSafetyConfig.getSignalingUrl();
            this.role = options.role || 'CLIENT'; // 'PHONE' or 'DASHBOARD'
            this.sessionId = options.sessionId || window.WomenSafetyConfig.getDefaultSessionId();
            this.deviceId = options.deviceId || (this.role.toLowerCase() + '-' + Math.random().toString(36).substring(2, 8));

            this.ws = null;
            this.isConnected = false;
            this.isRegistered = false;
            this.reconnectAttempts = 0;
            this.maxReconnectAttempts = 15;
            this.reconnectTimer = null;
            this.heartbeatTimer = null;

            // Callback hooks
            this.onOffer = null;
            this.onAnswer = null;
            this.onIceCandidate = null;
            this.onPeerConnected = null;
            this.onPeerDisconnected = null;
            this.onRequestOffer = null;
            this.onStatusChange = null;
            this.onError = null;
        }

        /**
         * Initiate WebSocket connection to Spring Boot signaling server
         */
        connect() {
            if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
                return;
            }

            this.updateStatus('Connecting...');
            console.log(`[WebSocket] Connecting to signaling server at: ${this.url}`);

            try {
                this.ws = new WebSocket(this.url);
            } catch (err) {
                console.error('[WebSocket] Failed to instantiate WebSocket:', err);
                this.updateStatus('Connection Lost');
                this.scheduleReconnect();
                return;
            }

            this.ws.onopen = () => {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                console.log('[WebSocket] Connected');
                this.updateStatus('Connected to Signaling Server');

                // Immediately register role and deviceId
                this.register();

                // Start heartbeat
                this.startHeartbeat();
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data);
            };

            this.ws.onerror = (err) => {
                console.warn('[WebSocket] Error encountered:', err);
                if (this.onError) {
                    this.onError(err);
                }
            };

            this.ws.onclose = (event) => {
                console.log(`[WebSocket] Connection closed (code: ${event.code}, reason: ${event.reason || 'None'})`);
                this.isConnected = false;
                this.isRegistered = false;
                this.stopHeartbeat();
                this.updateStatus('Connection Lost');
                this.scheduleReconnect();
            };
        }

        /**
         * Register this client identity with Spring Boot backend
         */
        register() {
            if (!this.isConnected || !this.ws) return;

            const registerPayload = {
                type: 'REGISTER',
                sessionId: this.sessionId,
                role: this.role,
                deviceId: this.deviceId
            };

            this.sendRaw(registerPayload);
            console.log(`[WebSocket] Registered as ${this.role}`);
            this.isRegistered = true;
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
                        console.log(`[WebSocket] Registration confirmed by server for deviceId: ${message.deviceId}`);
                        break;

                    case 'OFFER':
                        console.log('[WebSocket] Offer received from:', message.deviceId);
                        if (this.onOffer) {
                            this.onOffer(message.payload, message.deviceId, message.sessionId);
                        }
                        break;

                    case 'ANSWER':
                        console.log('[WebSocket] Answer received');
                        if (this.onAnswer) {
                            this.onAnswer(message.payload, message.deviceId, message.sessionId);
                        }
                        break;

                    case 'ICE_CANDIDATE':
                        console.log('[WebRTC] ICE candidate received');
                        if (this.onIceCandidate) {
                            this.onIceCandidate(message.payload, message.deviceId, message.sessionId);
                        }
                        break;

                    case 'REQUEST_OFFER':
                        console.log('[WebSocket] Server requested fresh SDP offer for peer');
                        if (this.onRequestOffer) {
                            this.onRequestOffer(message.deviceId);
                        }
                        break;

                    case 'PEER_CONNECTED':
                        console.log('[WebSocket] Peer connected notification:', message.payload || message.deviceId);
                        if (this.onPeerConnected) {
                            this.onPeerConnected(message.payload || { deviceId: message.deviceId, role: message.role });
                        }
                        break;

                    case 'PEER_DISCONNECTED':
                    case 'STREAM_STOPPED':
                        console.log('[WebSocket] Peer disconnected notification:', message.payload || message.deviceId);
                        if (this.onPeerDisconnected) {
                            this.onPeerDisconnected(message.payload || { deviceId: message.deviceId, role: message.role });
                        }
                        break;

                    case 'PONG':
                        // Heartbeat reply, no action needed
                        break;

                    case 'ERROR':
                        console.error('[WebSocket] Server error message:', message.payload);
                        if (this.onError) {
                            this.onError(message.payload);
                        }
                        break;

                    default:
                        console.log('[WebSocket] Unhandled message type:', type, message);
                        break;
                }
            } catch (err) {
                console.error('[WebSocket] Malformed message received:', err, rawData);
            }
        }

        /**
         * Send SDP Offer to dashboard(s)
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
            console.log('[WebSocket] Offer sent');
        }

        /**
         * Send SDP Answer to target phone
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
            console.log('[WebSocket] Answer sent');
        }

        /**
         * Send ICE Candidate to peer
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
        }

        /**
         * Notify server that camera stream was stopped
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
         * Internal raw JSON dispatch
         */
        sendRaw(obj) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(obj));
                return true;
            } else {
                console.warn('[WebSocket] Cannot send message: WebSocket is not open (state: ' + (this.ws ? this.ws.readyState : 'null') + ')');
                return false;
            }
        }

        /**
         * Exponential backoff reconnection
         */
        scheduleReconnect() {
            if (this.reconnectTimer) return;
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.warn('[WebSocket] Maximum reconnection attempts reached.');
                this.updateStatus('Connection Lost');
                return;
            }

            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
            this.updateStatus('Reconnecting...');
            console.log(`[WebSocket] Scheduling reconnect attempt #${this.reconnectAttempts} in ${Math.round(delay)}ms`);

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                // Re-evaluate URL in case user changed it
                this.url = window.WomenSafetyConfig.getSignalingUrl();
                this.connect();
            }, delay);
        }

        startHeartbeat() {
            this.stopHeartbeat();
            this.heartbeatTimer = setInterval(() => {
                if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.sendRaw({
                        type: 'PING',
                        sessionId: this.sessionId,
                        role: this.role,
                        deviceId: this.deviceId
                    });
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
            if (this.ws) {
                this.ws.onclose = null; // Prevent reconnect on manual close
                this.ws.close();
                this.ws = null;
            }
            this.isConnected = false;
            this.isRegistered = false;
        }
    }

    // Export class to window
    window.SignalingClient = SignalingClient;
})();
