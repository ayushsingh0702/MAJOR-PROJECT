/**
 * pairing.js
 *
 * Client-side pairing protocol module for Women Safety WebRTC System.
 *
 * Dashboard flow:
 *   1. Connect WebSocket
 *   2. Send CREATE_PAIRING_SESSION
 *   3. Receive PAIRING_SESSION_CREATED (contains pairingCode, pairingSessionId, dashboardAuthToken)
 *   4. Display QR code + pairing code + countdown
 *   5. Receive DEVICE_PAIRED when phone connects
 *   6. Now allow streaming
 *
 * Phone flow:
 *   1. Connect WebSocket
 *   2. User enters pairing code (or arrives via QR URL param)
 *   3. Send JOIN_PAIRING_SESSION with pairingCode
 *   4. Receive PAIRING_APPROVED (contains phoneAuthToken, pairingSessionId)
 *   5. Show Paired Successfully screen
 *   6. User taps Start Streaming
 *
 * Security notes:
 * - authToken is stored ONLY in memory (no localStorage, no URL)
 * - pairingCode is NOT the auth token; it's consumed once
 * - All subsequent signaling messages include the authToken for server-side validation
 */

(function () {
    'use strict';

    function getValidatedSignalingUrl(clientName, url) {
        if (!url) {
            throw new Error(`${clientName}: signaling URL is not configured. Set ?ws=wss://<backend>/ws.`);
        }
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            throw new Error(`${clientName}: signaling URL is invalid.`);
        }
        const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        if (window.location.protocol === 'https:' && parsed.protocol !== 'wss:' && !isLocal) {
            throw new Error(`${clientName}: HTTPS pages require a WSS signaling URL.`);
        }
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
            throw new Error(`${clientName}: signaling URL must use ws:// or wss://.`);
        }
        return parsed.href;
    }

    // =========================================================================
    // DASHBOARD PAIRING CLIENT
    // =========================================================================

    class DashboardPairingClient {
        constructor(options = {}) {
            this.signalingUrl = options.signalingUrl || window.WomenSafetyConfig.getSignalingUrl();
            this.deviceId = options.deviceId || ('dashboard-' + Math.random().toString(36).substring(2, 8));

            // Pairing state (in memory only)
            this.pairingSessionId = null;
            this.authToken = null;         // Dashboard auth token from server
            this.pairingCode = null;        // Display only
            this.expiresAt = null;
            this.pairedPhoneDeviceId = null;
            this.pairedAt = null;

            // State machine
            this.state = 'IDLE'; // IDLE | CONNECTING | WAITING_FOR_PAIRING | PAIRING_REQUESTED | PAIRED | CAMERA_READY | STREAMING | DISCONNECTED | UNPAIRED

            // WebSocket client
            this.ws = null;
            this.isConnected = false;

            // Countdown timer
            this.countdownTimer = null;
            this.countdownSeconds = 0;

            // Callbacks
            this.onStateChange = null;
            this.onPairingSessionCreated = null;
            this.onDevicePaired = null;
            this.onDeviceUnpaired = null;
            this.onDeviceDisconnected = null;
            this.onPairingRequested = null;
            this.onCameraReady = null;
            this.onStreamStarted = null;
            this.onStreamStopped = null;
            this.onError = null;
            this.onOfferReceived = null;
            this.onAnswerNeeded = null;    // Called when dashboard should send answer
            this.onIceCandidateReceived = null;
            this.onCodeExpired = null;
        }

        /**
         * Connect to backend and create a pairing session.
         */
        connect() {
            this.setState('CONNECTING');
            return new Promise((resolve, reject) => {
                try {
                    this.ws = new WebSocket(getValidatedSignalingUrl('Dashboard', this.signalingUrl));
                } catch (e) {
                    this.setState('IDLE');
                    reject(e);
                    return;
                }

                const timeout = setTimeout(() => {
                    reject(new Error('WebSocket connection timed out'));
                    this.ws && this.ws.close();
                }, 15000);

                this.ws.onopen = () => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    console.log('[DashboardPairing] WebSocket connected');
                    this.createPairingSession();
                    resolve(this);
                };

                this.ws.onmessage = (event) => {
                    this._handleMessage(event.data);
                };

                this.ws.onerror = (err) => {
                    console.error('[DashboardPairing] WebSocket error:', err);
                };

                this.ws.onclose = (event) => {
                    this.isConnected = false;
                    clearTimeout(timeout);
                    console.log('[DashboardPairing] WebSocket closed:', event.code);
                    this.stopCountdown();
                    this.authToken = null;
                    this.pairingSessionId = null;
                    this.pairedPhoneDeviceId = null;
                    this.setState('DISCONNECTED');
                    if (this.onError) {
                        this.onError({ errorCode: 'WS_DISCONNECTED', error: 'Signaling connection was closed.' });
                    }
                };
            });
        }

        createPairingSession() {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            const msg = {
                type: 'CREATE_PAIRING_SESSION',
                role: 'DASHBOARD',
                deviceId: this.deviceId
            };
            this.ws.send(JSON.stringify(msg));
            this.setState('WAITING_FOR_PAIRING');
            console.log('[DashboardPairing] CREATE_PAIRING_SESSION sent');
        }

        _handleMessage(rawData) {
            let message;
            try {
                message = JSON.parse(rawData);
            } catch (e) {
                console.error('[DashboardPairing] Invalid signaling JSON received');
                return;
            }

            const type = (message.type || '').toUpperCase();
            console.log('[DashboardPairing] Received:', type);

            switch (type) {
                case 'PAIRING_SESSION_CREATED': {
                    const payload = message.payload || {};
                    this.pairingSessionId = message.pairingSessionId || payload.pairingSessionId;
                    this.authToken = message.authToken; // Store in memory only
                    this.pairingCode = payload.pairingCode;
                    this.expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
                    this.countdownSeconds = payload.secondsUntilExpiry || 120;

                    console.log('[DashboardPairing] Pairing session created, code ready (not logged for security)');
                    this.startCountdown();
                    this.setState('WAITING_FOR_PAIRING');

                    if (this.onPairingSessionCreated) {
                        this.onPairingSessionCreated({
                            pairingCode: this.pairingCode,
                            pairingSessionId: this.pairingSessionId,
                            phoneUrl: payload.phoneUrl,
                            secondsUntilExpiry: this.countdownSeconds
                        });
                    }
                    break;
                }

                case 'DEVICE_PAIRED': {
                    const payload = message.payload || {};
                    this.pairedPhoneDeviceId = payload.phoneDeviceId;
                    this.pairedAt = payload.pairedAt ? new Date(payload.pairedAt) : new Date();
                    this.stopCountdown();
                    this.setState('PAIRED');
                    console.log('[DashboardPairing] Device paired:', this.pairedPhoneDeviceId);

                    if (this.onDevicePaired) {
                        this.onDevicePaired({
                            phoneDeviceId: this.pairedPhoneDeviceId,
                            pairingSessionId: this.pairingSessionId,
                            pairedAt: this.pairedAt
                        });
                    }
                    break;
                }

                case 'PAIRING_REQUESTED': {
                    this.setState('PAIRING_REQUESTED');
                    if (this.onPairingRequested) this.onPairingRequested(message.payload || {});
                    break;
                }

                case 'CAMERA_READY': {
                    this.setState('CAMERA_READY');
                    if (this.onCameraReady) this.onCameraReady(message.payload || {});
                    break;
                }

                case 'DEVICE_UNPAIRED': {
                    this.pairedPhoneDeviceId = null;
                    this.pairedAt = null;
                    this.setState('UNPAIRED');
                    console.log('[DashboardPairing] Device unpaired');

                    if (this.onDeviceUnpaired) {
                        this.onDeviceUnpaired(message.payload || {});
                    }
                    break;
                }

                case 'DEVICE_DISCONNECTED': {
                    const payload = message.payload || {};
                    this.setState('DISCONNECTED');
                    console.log('[DashboardPairing] Phone disconnected:', payload);

                    if (this.onDeviceDisconnected) {
                        this.onDeviceDisconnected(payload);
                    }
                    break;
                }

                case 'STREAM_STARTED': {
                    if (this.onStreamStarted) {
                        this.onStreamStarted(message.payload || {});
                    }
                    break;
                }

                case 'STREAM_STOPPED': {
                    this.setState('PAIRED');
                    if (this.onStreamStopped) {
                        this.onStreamStopped(message.payload || {});
                    }
                    break;
                }

                case 'OFFER': {
                    console.log('[DashboardPairing] OFFER received from phone');
                    if (this.onOfferReceived) {
                        this.onOfferReceived(message.payload, message.deviceId);
                    }
                    break;
                }

                case 'ICE_CANDIDATE': {
                    if (this.onIceCandidateReceived) {
                        this.onIceCandidateReceived(message.payload, message.deviceId);
                    }
                    break;
                }

                case 'PONG':
                    // Heartbeat
                    break;

                case 'ERROR': {
                    const errPayload = message.payload || {};
                    console.error('[DashboardPairing] Server error:', errPayload.errorCode, errPayload.error);
                    if (this.onError) {
                        this.onError(errPayload);
                    }
                    break;
                }

                default:
                    console.log('[DashboardPairing] Unhandled message type:', type);
                    break;
            }
        }

        /**
         * Send an SDP answer to the paired phone.
         */
        sendAnswer(answer) {
            if (!this.authToken || !this.pairingSessionId) {
                console.error('[DashboardPairing] Cannot send ANSWER - not paired');
                return false;
            }
            const msg = {
                type: 'ANSWER',
                role: 'DASHBOARD',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken,
                targetDeviceId: this.pairedPhoneDeviceId,
                payload: answer
            };
            return this._sendRaw(msg);
        }

        /**
         * Send an ICE candidate to the paired phone.
         */
        sendIceCandidate(candidate) {
            if (!this.authToken || !this.pairingSessionId) return false;
            const msg = {
                type: 'ICE_CANDIDATE',
                role: 'DASHBOARD',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken,
                targetDeviceId: this.pairedPhoneDeviceId,
                payload: candidate
            };
            return this._sendRaw(msg);
        }

        sendStreamStopped() {
            if (!this.authToken || !this.pairingSessionId) return false;
            return this._sendRaw({
                type: 'STREAM_STOPPED',
                role: 'DASHBOARD',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken,
                payload: { reason: 'Stopped by dashboard user' }
            });
        }

        sendStreamStarted() {
            if (!this.authToken || !this.pairingSessionId) return false;
            return this._sendRaw({
                type: 'STREAM_STARTED',
                role: 'DASHBOARD',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken,
                payload: { status: 'STREAMING' }
            });
        }

        /**
         * Request a fresh offer from the phone.
         */
        requestOffer() {
            if (!this.authToken || !this.pairingSessionId) return false;
            const msg = {
                type: 'REQUEST_OFFER',
                role: 'DASHBOARD',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken,
                targetDeviceId: this.pairedPhoneDeviceId
            };
            return this._sendRaw(msg);
        }

        /**
         * Send UNPAIR request to revoke phone authorization.
         */
        unpair() {
            if (!this.authToken || !this.pairingSessionId) return false;
            const msg = {
                type: 'UNPAIR',
                role: 'DASHBOARD',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken
            };
            const sent = this._sendRaw(msg);
            if (!sent) return false;
            this.pairedPhoneDeviceId = null;
            this.authToken = null;
            this.pairingSessionId = null;
            this.setState('UNPAIRED');
            return true;
        }

        _sendRaw(obj) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(JSON.stringify(obj));
                    return true;
                } catch (error) {
                    console.error('[DashboardPairing] Failed to send signaling message:', obj.type, error);
                    if (this.onError) this.onError({ errorCode: 'WS_SEND_FAILED', error: error.message });
                }
            }
            if (this.onError) this.onError({ errorCode: 'WS_NOT_READY', error: 'Signaling socket is not open.' });
            return false;
        }

        setState(newState) {
            const oldState = this.state;
            this.state = newState;
            if (oldState !== newState) {
                console.log(`[DashboardPairing] State: ${oldState} -> ${newState}`);
                if (this.onStateChange) {
                    this.onStateChange(newState, oldState);
                }
            }
        }

        isPaired() {
            return this.authToken != null && this.pairingSessionId != null
                && ['PAIRED', 'CAMERA_READY', 'STREAMING'].includes(this.state);
        }

        startCountdown() {
            this.stopCountdown();
            this.countdownTimer = setInterval(() => {
                this.countdownSeconds = Math.max(0, this.countdownSeconds - 1);
                if (this.countdownSeconds <= 0) {
                    this.stopCountdown();
                    if (this.state === 'WAITING_FOR_PAIRING') {
                        this.setState('WAITING_FOR_PAIRING'); // Trigger UI update showing expired
                        if (this.onCodeExpired) this.onCodeExpired();
                    }
                }
            }, 1000);
        }

        stopCountdown() {
            if (this.countdownTimer) {
                clearInterval(this.countdownTimer);
                this.countdownTimer = null;
            }
        }

        getCountdownFormatted() {
            const m = Math.floor(this.countdownSeconds / 60);
            const s = this.countdownSeconds % 60;
            return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }

        isCodeExpired() {
            return this.countdownSeconds <= 0;
        }

        disconnect() {
            this.stopCountdown();
            if (this.ws) {
                this.ws.onclose = null;
                this.ws.close();
                this.ws = null;
            }
            this.isConnected = false;
            this.authToken = null;
        }
    }

    // =========================================================================
    // PHONE PAIRING CLIENT
    // =========================================================================

    class PhonePairingClient {
        constructor(options = {}) {
            this.signalingUrl = options.signalingUrl || window.WomenSafetyConfig.getSignalingUrl();
            this.deviceId = options.deviceId || ('phone-' + Math.random().toString(36).substring(2, 8));

            // Pairing state (in memory only)
            this.pairingSessionId = null;
            this.authToken = null;          // Phone auth token from server
            this.dashboardDeviceId = null;
            this.pairedAt = null;

            this.state = 'IDLE';

            this.ws = null;
            this.isConnected = false;

            // Callbacks
            this.onStateChange = null;
            this.onPairingApproved = null;
            this.onPairingRejected = null;
            this.onDeviceUnpaired = null;
            this.onStreamStopped = null;
            this.onDisconnected = null;
            this.onAnswerReceived = null;
            this.onIceCandidateReceived = null;
            this.onRequestOffer = null;
            this.onError = null;
        }

        /**
         * Connect to backend WebSocket.
         */
        connect() {
            this.setState('CONNECTING');
            return new Promise((resolve, reject) => {
                try {
                    this.ws = new WebSocket(getValidatedSignalingUrl('Phone', this.signalingUrl));
                } catch (e) {
                    this.setState('IDLE');
                    reject(e);
                    return;
                }

                const timeout = setTimeout(() => {
                    reject(new Error('WebSocket connection timed out'));
                    this.ws && this.ws.close();
                }, 15000);

                this.ws.onopen = () => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    this.setState('CONNECTED');
                    console.log('[PhonePairing] WebSocket connected');
                    resolve(this);
                };

                this.ws.onmessage = (event) => {
                    this._handleMessage(event.data);
                };

                this.ws.onerror = (err) => {
                    console.error('[PhonePairing] WebSocket error:', err);
                };

                this.ws.onclose = (event) => {
                    this.isConnected = false;
                    clearTimeout(timeout);
                    console.log('[PhonePairing] WebSocket closed:', event.code);
                    this.stopHeartbeat();
                    if (this.authToken) {
                        this.authToken = null;
                        this.pairingSessionId = null;
                        this.setState('DISCONNECTED');
                        if (this.onDisconnected) {
                            this.onDisconnected({ reason: 'Signaling connection was lost.' });
                        }
                    } else if (this.state !== 'UNPAIRED') {
                        this.setState('IDLE');
                    }
                };
            });
        }

        /**
         * Submit a pairing code to join a dashboard session.
         * @param {string} code - The pairing code (e.g. "ABC-123")
         */
        joinPairingSession(code) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                console.error('[PhonePairing] Cannot join: WebSocket not open');
                return;
            }
            const msg = {
                type: 'JOIN_PAIRING_SESSION',
                role: 'PHONE',
                deviceId: this.deviceId,
                pairingCode: code.trim().toUpperCase()
            };
            this.ws.send(JSON.stringify(msg));
            this.setState('PAIRING_REQUESTED');
            console.log('[PhonePairing] JOIN_PAIRING_SESSION sent (code not logged for security)');
        }

        _handleMessage(rawData) {
            let message;
            try {
                message = JSON.parse(rawData);
            } catch (e) {
                console.error('[PhonePairing] Invalid signaling JSON received');
                return;
            }

            const type = (message.type || '').toUpperCase();
            console.log('[PhonePairing] Received:', type);

            switch (type) {
                case 'PAIRING_APPROVED': {
                    const payload = message.payload || {};
                    this.pairingSessionId = message.pairingSessionId || payload.pairingSessionId;
                    this.authToken = message.authToken; // Store in memory only - never log
                    this.dashboardDeviceId = payload.dashboardDeviceId;
                    this.deviceId = payload.phoneDeviceId || this.deviceId;
                    this.pairedAt = payload.pairedAt ? new Date(payload.pairedAt) : new Date();
                    this.setState('PAIRED');
                    console.log('[PhonePairing] Pairing approved, session established');

                    if (this.onPairingApproved) {
                        this.onPairingApproved({
                            pairingSessionId: this.pairingSessionId,
                            dashboardDeviceId: this.dashboardDeviceId,
                            pairedAt: this.pairedAt
                        });
                    }
                    break;
                }

                case 'PAIRING_REJECTED': {
                    const payload = message.payload || {};
                    this.setState('IDLE');
                    console.warn('[PhonePairing] Pairing rejected:', payload.errorCode, payload.reason);

                    if (this.onPairingRejected) {
                        this.onPairingRejected({
                            errorCode: payload.errorCode || 'REJECTED',
                            reason: payload.reason || 'Pairing was rejected'
                        });
                    }
                    break;
                }

                case 'PAIRING_EXPIRED': {
                    this.setState('IDLE');
                    if (this.onPairingRejected) {
                        this.onPairingRejected({ errorCode: 'EXPIRED', reason: 'Pairing code has expired' });
                    }
                    break;
                }

                case 'DEVICE_UNPAIRED': {
                    // Dashboard unpaired us - revoke auth immediately
                    this.authToken = null;
                    this.pairingSessionId = null;
                    this.setState('UNPAIRED');
                    console.log('[PhonePairing] Device unpaired by dashboard');

                    if (this.onDeviceUnpaired) {
                        this.onDeviceUnpaired(message.payload || {});
                    }
                    break;
                }

                case 'CAMERA_READY': {
                    this.setState('CAMERA_READY');
                    break;
                }

                case 'STREAM_STOPPED': {
                    this.setState('PAIRED');
                    if (this.onStreamStopped) this.onStreamStopped(message.payload || {});
                    break;
                }

                case 'STREAM_STARTED': {
                    this.setState('STREAMING');
                    break;
                }

                case 'ANSWER': {
                    console.log('[WebRTC] ANSWER received from dashboard');
                    if (this.onAnswerReceived) {
                        this.onAnswerReceived(message.payload, message.deviceId);
                    }
                    break;
                }

                case 'ICE_CANDIDATE': {
                    if (this.onIceCandidateReceived) {
                        this.onIceCandidateReceived(message.payload, message.deviceId);
                    }
                    break;
                }

                case 'REQUEST_OFFER': {
                    console.log('[WebRTC] Dashboard requested fresh offer');
                    if (this.onRequestOffer) {
                        this.onRequestOffer();
                    }
                    break;
                }

                case 'PONG':
                    break;

                case 'ERROR': {
                    const errPayload = message.payload || {};
                    console.error('[PhonePairing] Server error:', errPayload.errorCode, errPayload.error);
                    if (this.onError) {
                        this.onError(errPayload);
                    }
                    break;
                }

                default:
                    console.log('[PhonePairing] Unhandled message type:', type);
                    break;
            }
        }

        /**
         * Send SDP Offer to paired dashboard.
         */
        sendOffer(offer) {
            if (!this.authToken || !this.pairingSessionId) {
                console.error('[PhonePairing] Cannot send OFFER - not paired');
                return false;
            }
            const msg = {
                type: 'OFFER',
                role: 'PHONE',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken,
                payload: offer
            };
            const sent = this._sendRaw(msg);
            if (!sent) return false;
            console.log('[WebRTC] Phone OFFER sent to dashboard');
            return true;
        }

        /**
         * Send ICE candidate to paired dashboard.
         */
        sendIceCandidate(candidate) {
            if (!this.authToken || !this.pairingSessionId) return false;
            const msg = {
                type: 'ICE_CANDIDATE',
                role: 'PHONE',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken,
                payload: candidate
            };
            return this._sendRaw(msg);
        }

        sendCameraReady(settings) {
            if (!this.authToken || !this.pairingSessionId) return false;
            const sent = this._sendRaw({
                type: 'CAMERA_READY',
                role: 'PHONE',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken,
                payload: settings || {}
            });
            if (sent) this.setState('CAMERA_READY');
            return sent;
        }

        /**
         * Notify server that streaming has started.
         */
        sendStreamStarted() {
            if (!this.authToken || !this.pairingSessionId) return false;
            const msg = {
                type: 'STREAM_STARTED',
                role: 'PHONE',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken,
                payload: { status: 'STREAMING' }
            };
            return this._sendRaw(msg);
        }

        /**
         * Notify server that streaming has stopped.
         */
        sendStreamStopped() {
            if (!this.authToken || !this.pairingSessionId) return false;
            const msg = {
                type: 'STREAM_STOPPED',
                role: 'PHONE',
                deviceId: this.deviceId,
                pairingSessionId: this.pairingSessionId,
                authToken: this.authToken,
                payload: { reason: 'User stopped streaming' }
            };
            return this._sendRaw(msg);
        }

        /**
         * Send UNPAIR (phone-initiated disconnect).
         */
        unpair() {
            let sent = false;
            if (this.authToken) {
                const msg = {
                    type: 'UNPAIR',
                    role: 'PHONE',
                    deviceId: this.deviceId,
                    pairingSessionId: this.pairingSessionId,
                    authToken: this.authToken
                };
                sent = this._sendRaw(msg);
            }
            this.authToken = null;
            this.pairingSessionId = null;
            this.setState('UNPAIRED');
            return sent;
        }

        _sendRaw(obj) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(JSON.stringify(obj));
                    return true;
                } catch (error) {
                    console.error('[PhonePairing] Failed to send signaling message:', obj.type, error);
                    if (this.onError) this.onError({ errorCode: 'WS_SEND_FAILED', error: error.message });
                }
            }
            if (this.onError) this.onError({ errorCode: 'WS_NOT_READY', error: 'Signaling socket is not open.' });
            return false;
        }

        setState(newState) {
            const oldState = this.state;
            this.state = newState;
            if (oldState !== newState) {
                console.log(`[PhonePairing] State: ${oldState} -> ${newState}`);
                if (this.onStateChange) {
                    this.onStateChange(newState, oldState);
                }
            }
        }

        isPaired() {
            return this.authToken != null &&
                (this.state === 'PAIRED' || this.state === 'CAMERA_READY' || this.state === 'STREAMING');
        }

        disconnect() {
            this.stopHeartbeat();
            if (this.ws) {
                this.ws.onclose = null;
                this.ws.close();
                this.ws = null;
            }
            this.isConnected = false;
            this.authToken = null;
        }

        startHeartbeat() {
            this._heartbeatTimer = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'PING', role: 'PHONE', deviceId: this.deviceId }));
                }
            }, 25000);
        }

        stopHeartbeat() {
            if (this._heartbeatTimer) {
                clearInterval(this._heartbeatTimer);
                this._heartbeatTimer = null;
            }
        }
    }

    // Export to window
    window.DashboardPairingClient = DashboardPairingClient;
    window.PhonePairingClient = PhonePairingClient;

    console.log('[Pairing] Module loaded');
})();
