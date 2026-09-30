/**
 * webrtc.js
 * 
 * Phase 2: WebRTC Peer Connection & Streaming Architecture
 * 
 * Implements:
 * - RTCPeerConnection creation with STUN server configuration
 * - Modular SDP offer / answer negotiation functions
 * - ICE candidate gathering and handling (with race-condition queue)
 * - RTCRtpSender encoding quality parameters (bitrate / framerate)
 * - Adaptive quality / bandwidth adaptation
 * - Remote video track binding (peerConnection.ontrack)
 * - Connection and ICE state monitoring (WAITING, CONNECTING, CONNECTED, DISCONNECTED, FAILED)
 * - Development signaling adapter (BroadcastChannel / LocalStorage) for multi-tab testing
 * - Clear public interface ready for Spring Boot WebSocket integration in Phase 3
 */

(function () {
    'use strict';

    // STUN configuration for development
    const RTC_CONFIGURATION = {
        iceServers: [
            {
                urls: "stun:stun.l.google.com:19302"
            }
        ]
    };

    /**
     * Modular Local Development Signaling Channel
     * Allows seamless P2P negotiation across browser tabs without a backend server.
     * In Phase 3, this adapter will be swapped with Spring Boot WebSocket signaling.
     */
    class DevSignalingChannel {
        constructor(channelName = 'womensafety_dev_signaling') {
            this.channelName = channelName;
            this.broadcastChannel = null;
            this.onMessageCallback = null;

            if (typeof BroadcastChannel !== 'undefined') {
                this.broadcastChannel = new BroadcastChannel(this.channelName);
                this.broadcastChannel.onmessage = (event) => {
                    if (this.onMessageCallback && event.data) {
                        this.onMessageCallback(event.data);
                    }
                };
            }

            // Fallback via window storage events
            window.addEventListener('storage', (event) => {
                if (event.key === this.channelName && event.newValue) {
                    try {
                        const payload = JSON.parse(event.newValue);
                        if (this.onMessageCallback) {
                            this.onMessageCallback(payload);
                        }
                    } catch (e) {
                        // ignore malformed storage payload
                    }
                }
            });
        }

        send(message) {
            if (this.broadcastChannel) {
                try {
                    this.broadcastChannel.postMessage(message);
                } catch (err) {
                    console.warn("BroadcastChannel postMessage error:", err);
                }
            }
            try {
                localStorage.setItem(this.channelName, JSON.stringify({
                    ...message,
                    _timestamp: Date.now(),
                    _sender: Math.random().toString(36).substring(7)
                }));
            } catch (err) {
                // Ignore storage quota/security errors
            }
        }

        onMessage(callback) {
            this.onMessageCallback = callback;
        }

        close() {
            if (this.broadcastChannel) {
                this.broadcastChannel.close();
            }
        }
    }

    // Active connection state
    let peerConnection = null;
    let pendingIceCandidates = [];
    let currentRole = null; // 'phone-sender' or 'laptop-receiver'
    let signalingChannel = null;
    let localStream = null;

    /**
     * Check if WebRTC is supported by the current browser
     */
    function isWebRTCSupported() {
        return !!(window.RTCPeerConnection && window.RTCSessionDescription && window.RTCIceCandidate);
    }

    /**
     * Map WebRTC connection state to standardized status labels
     */
    function normalizeConnectionState(state) {
        switch (state) {
            case 'new':
            case 'connecting':
                return 'CONNECTING';
            case 'connected':
                return 'CONNECTED';
            case 'disconnected':
                return 'DISCONNECTED';
            case 'failed':
                return 'FAILED';
            case 'closed':
            default:
                return 'WAITING';
        }
    }

    /**
     * Configure encoding parameters on RTCRtpSender for high quality & low latency
     */
    async function configureSenderParameters(pc, videoTrack) {
        if (!pc || !videoTrack) return;
        try {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
            if (!sender || !sender.getParameters || !sender.setParameters) {
                console.warn("RTCRtpSender parameters modification is not supported by this browser.");
                return;
            }

            const parameters = sender.getParameters();
            if (!parameters.encodings || parameters.encodings.length === 0) {
                parameters.encodings = [{}];
            }

            const trackSettings = videoTrack.getSettings ? videoTrack.getSettings() : {};
            const height = trackSettings.height || 720;

            // Target bitrate settings:
            // ~4.5 Mbps for 1080p, ~2.5 Mbps for 720p, ~1.2 Mbps for lower resolutions
            let targetBitrate = 2500000;
            if (height >= 1080) {
                targetBitrate = 4500000;
            } else if (height < 720) {
                targetBitrate = 1200000;
            }

            parameters.encodings[0].maxBitrate = targetBitrate;
            parameters.encodings[0].maxFramerate = 30;

            // Prioritize framerate stability for security streaming
            if ('degradationPreference' in parameters) {
                parameters.degradationPreference = 'maintain-framerate';
            }

            await sender.setParameters(parameters);
            console.log(`[WebRTC] Video sender configured: maxBitrate=${(targetBitrate / 1000000).toFixed(1)} Mbps, maxFramerate=30 fps`);
        } catch (err) {
            console.warn("[WebRTC] Could not configure sender encoding parameters (non-critical):", err);
        }
    }

    /**
     * Create RTCPeerConnection instance with lifecycle and event handlers
     */
    function createPeerConnection(role = 'generic', onRemoteStream = null, onStateChange = null) {
        if (!isWebRTCSupported()) {
            const errorMsg = "WebRTC is not supported in this browser.";
            console.error(errorMsg);
            throw new Error(errorMsg);
        }

        if (peerConnection) {
            closePeerConnection();
        }

        currentRole = role;
        pendingIceCandidates = [];

        try {
            peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);
            console.log(`[WebRTC] PeerConnection created for role: ${role}`);
        } catch (err) {
            console.error("[WebRTC] PeerConnection creation failed:", err);
            throw err;
        }

        // ICE candidate generation
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log("[WebRTC] Local ICE candidate generated:", event.candidate.candidate);
                if (signalingChannel) {
                    signalingChannel.send({
                        type: 'ice-candidate',
                        candidate: event.candidate,
                        role: currentRole
                    });
                }
            } else {
                console.log("[WebRTC] ICE candidate gathering completed.");
            }
        };

        // Connection state monitoring
        peerConnection.onconnectionstatechange = () => {
            const rawState = peerConnection.connectionState;
            const normalizedState = normalizeConnectionState(rawState);
            console.log(`[WebRTC] Connection state: ${rawState} (${normalizedState})`);

            if (onStateChange) {
                onStateChange(normalizedState, rawState);
            }
            updateUIConnectionState(normalizedState, rawState);
        };

        // ICE connection state monitoring
        peerConnection.oniceconnectionstatechange = () => {
            const iceState = peerConnection.iceConnectionState;
            console.log(`[WebRTC] ICE connection state: ${iceState}`);

            const debugIceEl = document.getElementById('debugICE') || document.getElementById('dashboard-debug-ice');
            if (debugIceEl) {
                debugIceEl.textContent = iceState;
            }

            if (iceState === 'failed') {
                console.error("[WebRTC] ICE Connection failed. Check network or STUN availability.");
                handleError("ICE connection failed. Ensure both devices can reach STUN or local network.");
            }
        };

        // Remote track arrival (primarily for laptop dashboard receiver)
        peerConnection.ontrack = (event) => {
            console.log("[WebRTC] Remote track received:", event.track.kind, event.streams);
            if (onRemoteStream) {
                onRemoteStream(event.streams[0], event.track);
            }
            handleRemoteTrackReceived(event);
        };

        return peerConnection;
    }

    /**
     * Create an SDP offer and set as local description
     */
    async function createOffer(options = {}) {
        if (!peerConnection) {
            throw new Error("PeerConnection is not initialized. Call createPeerConnection first.");
        }
        try {
            const offer = await peerConnection.createOffer(options);
            await peerConnection.setLocalDescription(offer);
            console.log("[WebRTC] Local SDP Offer created and applied.");
            return offer;
        } catch (err) {
            console.error("[WebRTC] Failed to create SDP offer:", err);
            handleError("Failed to create WebRTC offer.");
            throw err;
        }
    }

    /**
     * Create an SDP answer and set as local description
     */
    async function createAnswer(options = {}) {
        if (!peerConnection) {
            throw new Error("PeerConnection is not initialized. Call createPeerConnection first.");
        }
        try {
            const answer = await peerConnection.createAnswer(options);
            await peerConnection.setLocalDescription(answer);
            console.log("[WebRTC] Local SDP Answer created and applied.");
            return answer;
        } catch (err) {
            console.error("[WebRTC] Failed to create SDP answer:", err);
            handleError("Failed to create WebRTC answer.");
            throw err;
        }
    }

    /**
     * Handle incoming remote SDP offer
     */
    async function handleOffer(offer) {
        if (!peerConnection) {
            createPeerConnection('laptop-receiver');
        }
        try {
            console.log("[WebRTC] Applying remote SDP Offer...");
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            console.log("[WebRTC] Remote description set successfully.");

            // Drain queued ICE candidates received prior to remote description
            await flushPendingIceCandidates();
        } catch (err) {
            console.error("[WebRTC] Error handling remote offer:", err);
            handleError("Unable to process remote connection offer.");
            throw err;
        }
    }

    /**
     * Handle incoming remote SDP answer
     */
    async function handleAnswer(answer) {
        if (!peerConnection) {
            console.warn("[WebRTC] Cannot handle answer: PeerConnection not initialized.");
            return;
        }
        try {
            console.log("[WebRTC] Applying remote SDP Answer...");
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            console.log("[WebRTC] Remote answer set successfully.");

            // Drain queued ICE candidates
            await flushPendingIceCandidates();
        } catch (err) {
            console.error("[WebRTC] Error handling remote answer:", err);
            handleError("Unable to establish WebRTC connection with remote peer.");
            throw err;
        }
    }

    /**
     * Handle incoming remote ICE candidate (with queuing for race conditions)
     */
    async function handleIceCandidate(candidateInit) {
        if (!candidateInit) return;

        // If remote description is not set yet, queue candidate
        if (!peerConnection || !peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
            console.log("[WebRTC] Queueing ICE candidate until remote description is set.");
            pendingIceCandidates.push(candidateInit);
            return;
        }

        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidateInit));
            console.log("[WebRTC] Remote ICE candidate added successfully.");
        } catch (err) {
            console.warn("[WebRTC] Failed to add remote ICE candidate:", err);
        }
    }

    /**
     * Flush all queued ICE candidates
     */
    async function flushPendingIceCandidates() {
        if (!peerConnection || !peerConnection.remoteDescription) return;
        while (pendingIceCandidates.length > 0) {
            const candidate = pendingIceCandidates.shift();
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                console.log("[WebRTC] Flushed queued ICE candidate.");
            } catch (err) {
                console.warn("[WebRTC] Error adding queued ICE candidate:", err);
            }
        }
    }

    /**
     * Close and cleanly tear down PeerConnection
     */
    function closePeerConnection() {
        if (peerConnection) {
            peerConnection.ontrack = null;
            peerConnection.onicecandidate = null;
            peerConnection.onconnectionstatechange = null;
            peerConnection.oniceconnectionstatechange = null;
            peerConnection.close();
            peerConnection = null;
            console.log("[WebRTC] PeerConnection closed.");
        }
        pendingIceCandidates = [];
        updateUIConnectionState('WAITING', 'closed');
    }

    /**
     * Display readable error message on current page
     */
    function handleError(message) {
        const errorEl = document.getElementById('errorMessage') || document.getElementById('dashboardErrorMessage');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.style.display = 'block';
        }
    }

    /**
     * Clear error message on current page
     */
    function clearError() {
        const errorEl = document.getElementById('errorMessage') || document.getElementById('dashboardErrorMessage');
        if (errorEl) {
            errorEl.textContent = '';
            errorEl.style.display = 'none';
        }
    }

    /**
     * Update connection badges and debug displays
     */
    function updateUIConnectionState(normalizedState, rawState) {
        // Phone page elements
        const webrtcStatusEl = document.getElementById('webrtcStatus');
        const debugWebRTCEl = document.getElementById('debugWebRTC');
        if (webrtcStatusEl) {
            webrtcStatusEl.textContent = normalizedState;
            webrtcStatusEl.className = `badge status-${normalizedState.toLowerCase()}`;
        }
        if (debugWebRTCEl) {
            debugWebRTCEl.textContent = `Connection: ${normalizedState}`;
        }

        // Laptop dashboard elements
        const dashboardStatusBadge = document.getElementById('camera-01-status') || document.getElementById('dashboardCameraStatus');
        const dashboardDebugState = document.getElementById('dashboard-debug-webrtc');
        if (dashboardStatusBadge) {
            if (normalizedState === 'CONNECTED') {
                dashboardStatusBadge.innerHTML = '<span class="badge-dot"></span> CONNECTED';
                dashboardStatusBadge.className = 'badge badge-connected';
            } else if (normalizedState === 'CONNECTING') {
                dashboardStatusBadge.innerHTML = '<span class="badge-dot"></span> CONNECTING';
                dashboardStatusBadge.className = 'badge badge-warning';
            } else if (normalizedState === 'FAILED') {
                dashboardStatusBadge.innerHTML = '<span class="badge-dot"></span> FAILED';
                dashboardStatusBadge.className = 'badge badge-disconnected';
            } else if (normalizedState === 'DISCONNECTED') {
                dashboardStatusBadge.innerHTML = '<span class="badge-dot"></span> DISCONNECTED';
                dashboardStatusBadge.className = 'badge badge-disconnected';
            } else {
                dashboardStatusBadge.innerHTML = '<span class="badge-dot"></span> WAITING FOR CAMERA';
                dashboardStatusBadge.className = 'badge badge-disconnected';
            }
        }
        if (dashboardDebugState) {
            dashboardDebugState.textContent = `Connection: ${normalizedState}`;
        }
    }

    /**
     * Handle incoming remote track on dashboard
     */
    function handleRemoteTrackReceived(event) {
        const remoteVideo = document.getElementById('remoteVideo') || document.getElementById('remote-video-feed-01');
        const placeholder = document.getElementById('stream-placeholder-01') || document.getElementById('remotePlaceholder');

        if (!remoteVideo) return;

        const incomingStream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
        remoteVideo.srcObject = incomingStream;
        remoteVideo.style.display = 'block';

        if (placeholder) {
            placeholder.style.display = 'none';
        }

        try {
            remoteVideo.play().catch(e => console.log("[WebRTC] Autoplay note:", e));
        } catch (e) {
            console.log("[WebRTC] Video play error:", e);
        }

        // Inspect remote resolution when stream metadata is available
        remoteVideo.onloadedmetadata = () => {
            const width = remoteVideo.videoWidth;
            const height = remoteVideo.videoHeight;
            console.log(`[WebRTC] Remote video rendering: ${width} × ${height}`);

            const resStatEl = document.getElementById('stat-resolution');
            if (resStatEl) {
                resStatEl.textContent = `${width} × ${height}`;
            }
            const debugStreamEl = document.getElementById('dashboard-debug-stream');
            if (debugStreamEl) {
                debugStreamEl.textContent = `Stream: ${width} × ${height}`;
            }
        };

        updateUIConnectionState('CONNECTED', 'connected');
    }

    // =========================================================================
    // PHONE SENDER WORKFLOW
    // =========================================================================

    async function startPhoneStreaming(stream) {
        clearError();
        localStream = stream;

        try {
            // 1. Create PeerConnection for Phone Sender
            createPeerConnection('phone-sender');

            // 2. Add camera video track
            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack) {
                peerConnection.addTrack(videoTrack, stream);
                console.log("[WebRTC] Added camera video track to PeerConnection.");

                // 3. Configure bitrate / framerate quality parameters
                await configureSenderParameters(peerConnection, videoTrack);
            } else {
                throw new Error("No video track found in camera stream.");
            }

            // 4. Create and dispatch SDP Offer
            const offer = await createOffer();
            console.log("[WebRTC] Dispatching offer via development signaling channel...");
            if (signalingChannel) {
                signalingChannel.send({
                    type: 'offer',
                    offer: offer,
                    role: 'phone-sender'
                });
            }
        } catch (err) {
            console.error("[WebRTC] Failed to initialize phone streaming:", err);
            handleError("Unable to initialize WebRTC streaming: " + err.message);
        }
    }

    function stopPhoneStreaming() {
        if (signalingChannel) {
            signalingChannel.send({
                type: 'stream-stopped',
                role: 'phone-sender'
            });
        }
        closePeerConnection();
        localStream = null;
    }

    // =========================================================================
    // LAPTOP DASHBOARD RECEIVER WORKFLOW
    // =========================================================================

    function initDashboardReceiver() {
        const remoteVideo = document.getElementById('remoteVideo') || document.getElementById('remote-video-feed-01');
        if (!remoteVideo) return;

        console.log("[WebRTC] Initializing Laptop Dashboard WebRTC Receiver...");
        updateUIConnectionState('WAITING', 'waiting');

        // Create PeerConnection ready for incoming offer
        createPeerConnection('laptop-receiver', (stream) => {
            remoteVideo.srcObject = stream;
        });

        // Broadcast presence so phone can re-send offer if it was already streaming
        if (signalingChannel) {
            signalingChannel.send({
                type: 'request-offer',
                role: 'laptop-receiver'
            });
        }
    }

    function resetDashboardReceiverView() {
        const remoteVideo = document.getElementById('remoteVideo') || document.getElementById('remote-video-feed-01');
        const placeholder = document.getElementById('stream-placeholder-01') || document.getElementById('remotePlaceholder');

        if (remoteVideo) {
            remoteVideo.srcObject = null;
            remoteVideo.style.display = 'none';
        }
        if (placeholder) {
            placeholder.style.display = 'flex';
        }
        const resStatEl = document.getElementById('stat-resolution');
        if (resStatEl) {
            resStatEl.textContent = '--';
        }
        updateUIConnectionState('WAITING', 'waiting');
    }

    // =========================================================================
    // INITIALIZATION & SIGNALING DISPATCH
    // =========================================================================

    function initWebRTCModule() {
        // Initialize modular dev signaling
        signalingChannel = new DevSignalingChannel();

        signalingChannel.onMessage(async (message) => {
            if (!message || !message.type) return;

            // Handle incoming messages on phone sender
            if (currentRole === 'phone-sender') {
                if (message.type === 'answer' && message.answer) {
                    console.log("[WebRTC] Received SDP Answer from dashboard.");
                    await handleAnswer(message.answer);
                } else if (message.type === 'ice-candidate' && message.candidate && message.role !== 'phone-sender') {
                    console.log("[WebRTC] Received remote ICE candidate on phone.");
                    await handleIceCandidate(message.candidate);
                } else if (message.type === 'request-offer') {
                    console.log("[WebRTC] Dashboard requested fresh offer. Re-negotiating...");
                    if (localStream && peerConnection) {
                        try {
                            const offer = await createOffer({ iceRestart: true });
                            signalingChannel.send({
                                type: 'offer',
                                offer: offer,
                                role: 'phone-sender'
                            });
                        } catch (e) {
                            console.warn("Error re-negotiating offer:", e);
                        }
                    }
                }
            }

            // Handle incoming messages on laptop dashboard receiver
            if (currentRole === 'laptop-receiver') {
                if (message.type === 'offer' && message.offer) {
                    console.log("[WebRTC] Received SDP Offer from phone camera.");
                    try {
                        updateUIConnectionState('CONNECTING', 'connecting');
                        await handleOffer(message.offer);
                        const answer = await createAnswer();
                        console.log("[WebRTC] Dispatching SDP Answer to phone camera...");
                        signalingChannel.send({
                            type: 'answer',
                            answer: answer,
                            role: 'laptop-receiver'
                        });
                    } catch (e) {
                        console.error("[WebRTC] Error answering offer:", e);
                    }
                } else if (message.type === 'ice-candidate' && message.candidate && message.role !== 'laptop-receiver') {
                    console.log("[WebRTC] Received remote ICE candidate on dashboard.");
                    await handleIceCandidate(message.candidate);
                } else if (message.type === 'stream-stopped') {
                    console.log("[WebRTC] Phone camera stream stopped.");
                    resetDashboardReceiverView();
                    closePeerConnection();
                    // Re-initialize for next session
                    createPeerConnection('laptop-receiver');
                }
            }
        });

        // Listen for camera lifecycle events from camera.js
        window.addEventListener('womensafety:camera-started', (e) => {
            const stream = e.detail && e.detail.stream;
            if (stream) {
                startPhoneStreaming(stream);
            }
        });

        window.addEventListener('womensafety:camera-stopped', () => {
            stopPhoneStreaming();
        });

        // Detect if loaded on dashboard.html
        if (document.getElementById('remoteVideo') || document.getElementById('remote-video-feed-01')) {
            initDashboardReceiver();
        }

        // Clean up on window unload
        window.addEventListener('beforeunload', () => {
            closePeerConnection();
            if (signalingChannel) {
                signalingChannel.close();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWebRTCModule);
    } else {
        initWebRTCModule();
    }

    // Public API for external integration and testing
    window.WomenSafetyWebRTC = {
        createPeerConnection: createPeerConnection,
        createOffer: createOffer,
        createAnswer: createAnswer,
        handleOffer: handleOffer,
        handleAnswer: handleAnswer,
        handleIceCandidate: handleIceCandidate,
        closePeerConnection: closePeerConnection,
        getPeerConnection: () => peerConnection,
        getSignalingChannel: () => signalingChannel,
        startPhoneStreaming: startPhoneStreaming,
        stopPhoneStreaming: stopPhoneStreaming
    };
})();
