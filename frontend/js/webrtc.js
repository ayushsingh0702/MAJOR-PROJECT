/**
 * webrtc.js
 *
 * WebRTC Peer Connection & Real-Time Media Streaming Engine.
 *
 * Flow Overview:
 * PHONE:
 *   acquire camera stream -> connect & register signaling -> createPeerConnection
 *   -> addTrack -> createOffer -> setLocalDescription -> sendOffer -> wait for ANSWER
 *   -> setRemoteDescription -> ICE negotiation -> CONNECTED
 *
 * DASHBOARD:
 *   connect & register signaling -> receive OFFER -> createPeerConnection
 *   -> setRemoteDescription -> flush queued ICE -> createAnswer -> setLocalDescription
 *   -> sendAnswer -> ICE negotiation -> CONNECTED -> display remote video
 */

(function () {
    'use strict';

    // Base WebRTC Configuration (Google STUN servers)
    const RTC_CONFIGURATION = {
        iceServers: (window.WomenSafetyConfig && window.WomenSafetyConfig.getStunServers()) || [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" }
        ]
    };

    // State Variables
    let peerConnection = null;
    let signalingClient = null;
    let localStream = null;
    let remoteStream = null;
    let currentRole = null; // 'PHONE' or 'DASHBOARD'
    let pendingIceCandidates = [];
    let activePhoneDeviceId = 'phone-1';
    let isNegotiating = false;
    let hasQueuedNegotiation = false;
    let reconnectTimeout = null;
    let adaptationInterval = null;
    let rtcConfigurationExpiresAt = 0;
    let qualityLevel = 0;
    let poorNetworkSamples = 0;
    let healthyNetworkSamples = 0;
    let lastOutboundBytes = null;
    let lastOutboundTimestamp = null;
    const QUALITY_LEVELS = [
        { width: 1280, height: 720, frameRate: 30, bitrate: 2500000 },
        { width: 640, height: 360, frameRate: 24, bitrate: 1200000 },
        { width: 480, height: 270, frameRate: 15, bitrate: 650000 }
    ];

    async function loadRTCConfiguration(forceRefresh = false) {
        if (!window.WomenSafetyConfig) return;
        if (!forceRefresh && rtcConfigurationExpiresAt > Date.now() + 60000) return;
        const configuration = await window.WomenSafetyConfig.getIceConfiguration();
        RTC_CONFIGURATION.iceServers = configuration.iceServers;
        rtcConfigurationExpiresAt = configuration.expiresAt
            ? configuration.expiresAt * 1000
            : Date.now() + 30000;
        if (!configuration.turnConfigured) {
            console.warn('[ICE] TURN relay is not configured or unavailable; using STUN only');
        }
    }

    /**
     * Check WebRTC support in current browser context
     */
    function isWebRTCSupported() {
        return !!(window.RTCPeerConnection && window.RTCSessionDescription && window.RTCIceCandidate);
    }

    /**
     * Normalize and map WebRTC connection states for UI badges
     */
    function normalizeState(state) {
        switch (state) {
            case 'connected': return 'Connected';
            case 'connecting': return 'Connecting...';
            case 'disconnected': return 'Connection Lost';
            case 'failed': return 'Connection Failed';
            case 'closed': return 'Disconnected';
            default: return 'Waiting for camera...';
        }
    }

    /**
     * Configure RTCRtpSender encoding parameters for low-latency and high video quality
     */
    async function configureSenderParameters(pc, videoTrack) {
        if (!pc || !videoTrack) return;
        try {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!sender || !sender.getParameters || !sender.setParameters) return;

            const parameters = sender.getParameters();
            if (!parameters.encodings || parameters.encodings.length === 0) {
                parameters.encodings = [{}];
            }

            const level = QUALITY_LEVELS[qualityLevel];
            parameters.encodings[0].maxBitrate = level.bitrate;
            parameters.encodings[0].maxFramerate = level.frameRate;
            if ('degradationPreference' in parameters) parameters.degradationPreference = 'balanced';

            await sender.setParameters(parameters);
            if (videoTrack.applyConstraints) {
                await videoTrack.applyConstraints({
                    width: { ideal: level.width, max: level.width },
                    height: { ideal: level.height, max: level.height },
                    frameRate: { ideal: level.frameRate, max: level.frameRate }
                });
            }
            console.log(`[WebRTC] Video sender configured: ${level.width}x${level.height} @ ${level.frameRate} FPS`);
        } catch (err) {
            console.warn('[WebRTC] Note on encoding parameters (non-critical):', err.message);
        }
    }

    /**
     * Create RTCPeerConnection instance with comprehensive lifecycle listeners
     */
    function createPeerConnection(role) {
        if (!isWebRTCSupported()) {
            throw new Error("Your browser does not support WebRTC APIs.");
        }

        if (peerConnection && peerConnection.connectionState !== 'closed') {
            console.log('[WebRTC] Reusing or re-initializing existing peer connection...');
            closePeerConnection(false); // Preserve pending ICE candidate buffer during recreation
        }

        currentRole = role;
        console.log('[WebRTC] Creating PeerConnection');
        peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);

        // 1. ICE Candidate Gathering Listener
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('[ICE] Candidate generated');
                if (signalingClient) {
                    const target = (currentRole === 'DASHBOARD') ? activePhoneDeviceId : null;
                    signalingClient.sendIceCandidate(event.candidate.toJSON ? event.candidate.toJSON() : event.candidate, target);
                }
            } else {
                console.log('[ICE] Candidate gathering complete');
                if (signalingClient) {
                    const target = (currentRole === 'DASHBOARD') ? activePhoneDeviceId : null;
                    signalingClient.sendIceCandidate(null, target);
                }
            }
        };

        // 2. Peer Connection State Changes
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection ? peerConnection.connectionState : 'closed';
            console.log(`[WebRTC] Connection state = ${state}`);
            updateUIForConnectionState(state);

            if (state === 'failed') {
                console.warn('[WebRTC] Connection failed, attempting automatic reconnection...');
                scheduleReconnection();
            } else if (state === 'disconnected') {
                scheduleReconnection();
            } else if (state === 'connected') {
                clearTimeout(reconnectTimeout);
                reconnectTimeout = null;
                if (currentRole === 'PHONE') startAdaptiveStreaming();
            }
        };

        // 3. ICE Connection State Changes
        peerConnection.oniceconnectionstatechange = () => {
            const iceState = peerConnection ? peerConnection.iceConnectionState : 'closed';
            console.log(`[WebRTC] ICE state = ${iceState}`);

            const debugIce = document.getElementById('debugICE') || document.getElementById('dashboard-debug-ice-val');
            if (debugIce) {
                debugIce.textContent = iceState;
            }
            if (iceState === 'failed' || iceState === 'disconnected') scheduleReconnection();
        };

        // 4. Signaling State Changes
        peerConnection.onsignalingstatechange = () => {
            const sigState = peerConnection ? peerConnection.signalingState : 'closed';
            console.log(`[WebRTC] Signaling state = ${sigState}`);
        };

        // 5. ICE Gathering State Changes
        peerConnection.onicegatheringstatechange = () => {
            const gatherState = peerConnection ? peerConnection.iceGatheringState : 'closed';
            console.log(`[WebRTC] ICE gathering state = ${gatherState}`);
        };

        // 6. Remote Track Arrival (Laptop Dashboard)
        peerConnection.ontrack = (event) => {
            console.log('[WebRTC] Remote track received');
            remoteStream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
            handleRemoteStreamReceived(remoteStream);
        };

        return peerConnection;
    }

    /**
     * Flush queued ICE candidates once remote description is set
     */
    async function flushPendingIceCandidates() {
        if (!peerConnection || !peerConnection.remoteDescription) return;

        if (pendingIceCandidates.length > 0) {
            console.log(`[ICE] Flushing ${pendingIceCandidates.length} queued candidate(s)...`);
            while (pendingIceCandidates.length > 0) {
                const candidate = pendingIceCandidates.shift();
                try {
                    await peerConnection.addIceCandidate(candidate ? new RTCIceCandidate(candidate) : null);
                    console.log('[ICE] Candidate applied (from queue)');
                } catch (err) {
                    console.warn('[WebRTC] Error adding queued ICE candidate:', err);
                }
            }
        }
    }

    /**
     * Safely add ICE Candidate, queueing if remote description not yet set
     */
    async function addIceCandidateSafely(candidateInit) {
        // If peer connection or remote description is not ready, buffer candidate
        if (!peerConnection || !peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
            if (pendingIceCandidates.length >= 128) {
                console.error('[ICE] Candidate queue limit reached before remote description');
                return;
            }
            console.log('[ICE] Candidate queued (waiting for remote description)');
            pendingIceCandidates.push(candidateInit);
            return;
        }

        try {
            await peerConnection.addIceCandidate(candidateInit ? new RTCIceCandidate(candidateInit) : null);
            console.log('[ICE] Candidate applied');
        } catch (err) {
            console.warn('[WebRTC] Failed to add ICE candidate:', err);
        }
    }

    async function sampleSenderStats() {
        if (!peerConnection || peerConnection.connectionState === 'closed' || !localStream) return;
        const sender = peerConnection.getSenders().find(item => item.track && item.track.kind === 'video');
        if (!sender) return;
        try {
            const stats = await peerConnection.getStats();
            let outbound;
            let remoteInbound;
            let selectedPair;
            stats.forEach(report => {
                if (report.type === 'outbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) outbound = report;
                if (report.type === 'remote-inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) remoteInbound = report;
                if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) selectedPair = report;
            });
            const bytes = outbound && outbound.bytesSent;
            const timestamp = outbound && outbound.timestamp;
            let bitrate = 0;
            if (bytes != null && lastOutboundBytes != null && timestamp > lastOutboundTimestamp) {
                bitrate = Math.round(((bytes - lastOutboundBytes) * 8 * 1000) / (timestamp - lastOutboundTimestamp));
            }
            if (bytes != null) {
                lastOutboundBytes = bytes;
                lastOutboundTimestamp = timestamp;
            }
            const available = selectedPair && selectedPair.availableOutgoingBitrate;
            const packetCount = remoteInbound && (remoteInbound.packetsReceived || 0) + (remoteInbound.packetsLost || 0);
            const loss = packetCount ? (remoteInbound.packetsLost || 0) / packetCount : 0;
            const jitter = (remoteInbound && remoteInbound.jitter) || 0;
            const rtt = (selectedPair && selectedPair.currentRoundTripTime) || (remoteInbound && remoteInbound.roundTripTime) || 0;
            const poor = Boolean(outbound && outbound.qualityLimitationReason === 'bandwidth') ||
                (available != null && available < QUALITY_LEVELS[qualityLevel].bitrate * 0.9) ||
                loss > 0.05 || jitter > 0.05 || rtt > 0.5;
            if (poor) {
                poorNetworkSamples++;
                healthyNetworkSamples = 0;
            } else {
                healthyNetworkSamples++;
                poorNetworkSamples = 0;
            }
            if (poorNetworkSamples >= 2 && qualityLevel < QUALITY_LEVELS.length - 1) {
                qualityLevel++;
                poorNetworkSamples = 0;
                await configureSenderParameters(peerConnection, sender.track);
            } else if (healthyNetworkSamples >= 4 && qualityLevel > 0) {
                qualityLevel--;
                healthyNetworkSamples = 0;
                await configureSenderParameters(peerConnection, sender.track);
            }
            console.debug('[WebRTC] Sender stats', { bitrate, available, loss, jitter, rtt, qualityLevel });
        } catch (error) {
            console.warn('[WebRTC] Could not collect sender network statistics:', error.message);
        }
    }

    function startAdaptiveStreaming() {
        if (adaptationInterval) clearInterval(adaptationInterval);
        lastOutboundBytes = null;
        lastOutboundTimestamp = null;
        adaptationInterval = setInterval(sampleSenderStats, 5000);
    }

    /**
     * Update UI status indicators on both Phone and Dashboard pages
     */
    function updateUIForConnectionState(state) {
        // --- Phone Page Updates ---
        const connectionStatusEl = document.getElementById('connectionStatus') || document.getElementById('webrtcStatus');
        const debugWebRTCEl = document.getElementById('debugWebRTC');

        if (connectionStatusEl) {
            if (state === 'connected') {
                connectionStatusEl.textContent = '● Connected to Dashboard';
                connectionStatusEl.className = 'badge status-connected';
            } else if (state === 'connecting') {
                connectionStatusEl.textContent = 'Connecting...';
                connectionStatusEl.className = 'badge status-connecting';
            } else if (state === 'failed' || state === 'disconnected') {
                connectionStatusEl.textContent = 'Connection Lost';
                connectionStatusEl.className = 'badge status-waiting';
            } else {
                connectionStatusEl.textContent = normalizeState(state);
            }
        }

        if (debugWebRTCEl) {
            debugWebRTCEl.textContent = `Connection: ${normalizeState(state)}`;
        }

        // --- Dashboard Page Updates ---
        const dashboardStatus = document.getElementById('camera-01-status');
        const dashboardDebugState = document.getElementById('dashboard-debug-webrtc');
        const dashboardDebugVal = document.getElementById('dashboard-debug-webrtc-val');

        if (dashboardStatus) {
            if (state === 'connected') {
                dashboardStatus.innerHTML = '<span class="badge-dot"></span> CONNECTED';
                dashboardStatus.className = 'badge badge-connected';
            } else if (state === 'connecting') {
                dashboardStatus.innerHTML = '<span class="badge-dot"></span> CONNECTING...';
                dashboardStatus.className = 'badge badge-warning';
            } else if (state === 'disconnected') {
                dashboardStatus.innerHTML = '<span class="badge-dot"></span> PHONE DISCONNECTED';
                dashboardStatus.className = 'badge badge-disconnected';
            } else {
                dashboardStatus.innerHTML = '<span class="badge-dot"></span> WAITING FOR CAMERA...';
                dashboardStatus.className = 'badge badge-disconnected';
            }
        }

        if (dashboardDebugState) dashboardDebugState.textContent = normalizeState(state);
        if (dashboardDebugVal) dashboardDebugVal.textContent = state;

        const dashboardConn = document.getElementById('dashboard-debug-conn');
        if (dashboardConn) {
            dashboardConn.textContent = (state === 'connected') ? 'Connected' : normalizeState(state);
        }
        const statDevice = document.getElementById('stat-device');
        if (statDevice) {
            statDevice.textContent = activePhoneDeviceId || 'Phone 1';
        }
    }

    /**
     * Bind incoming remote MediaStream to Dashboard UI
     */
    function handleRemoteStreamReceived(stream) {
        const remoteVideo = document.getElementById('remoteVideo');
        const placeholder = document.getElementById('stream-placeholder-01');
        const deviceTag = document.getElementById('camera-label-01') || document.getElementById('dashboardDeviceTag');
        const resStatEl = document.getElementById('stat-resolution');
        const debugStreamEl = document.getElementById('dashboard-debug-stream');

        if (remoteVideo) {
            remoteVideo.srcObject = stream;
            remoteVideo.style.display = 'block';

            remoteVideo.play().catch(e => console.warn('[WebRTC] Remote play promise warning:', e.message));

            remoteVideo.onloadedmetadata = () => {
                const w = remoteVideo.videoWidth;
                const h = remoteVideo.videoHeight;
                console.log(`[WebRTC] Remote video rendering resolution: ${w} × ${h}`);
                if (resStatEl) resStatEl.textContent = `${w} × ${h}`;
                if (debugStreamEl) debugStreamEl.textContent = `${w} × ${h}`;
            };
        }

        if (placeholder) {
            placeholder.style.display = 'none';
        }

        if (deviceTag) {
            deviceTag.textContent = activePhoneDeviceId || 'Phone 1';
        }

        updateUIForConnectionState('connected');
    }

    /**
     * Reset dashboard UI back to waiting state
     */
    function resetDashboardUI(reason = 'Waiting for phone camera...') {
        const remoteVideo = document.getElementById('remoteVideo');
        const placeholder = document.getElementById('stream-placeholder-01');
        const resStatEl = document.getElementById('stat-resolution');
        const dashboardStatus = document.getElementById('camera-01-status');

        if (remoteVideo) {
            remoteVideo.srcObject = null;
            remoteVideo.style.display = 'none';
        }

        if (placeholder) {
            placeholder.style.display = 'flex';
            const hint = placeholder.querySelector('p');
            if (hint) hint.textContent = reason;
        }

        if (resStatEl) resStatEl.textContent = '--';

        if (dashboardStatus) {
            dashboardStatus.innerHTML = `<span class="badge-dot"></span> ${reason.toUpperCase()}`;
            dashboardStatus.className = 'badge badge-disconnected';
        }
    }

    /**
     * Automatic reconnection attempt
     */
    function scheduleReconnection() {
        if (reconnectTimeout) return;
        reconnectTimeout = setTimeout(async () => {
            reconnectTimeout = null;
            if (currentRole === 'PHONE' && localStream) {
                console.log('[WebRTC] Re-initiating phone WebRTC offer...');
            initiatePhoneOffer(true);
            } else if (currentRole === 'DASHBOARD') {
                if (signalingClient && signalingClient.isConnected) {
                    signalingClient.sendRaw({
                        type: 'REQUEST_OFFER',
                        sessionId: signalingClient.sessionId,
                        role: 'DASHBOARD',
                        deviceId: signalingClient.deviceId
                    });
                }
            }
        }, 2500);
    }

    /**
     * Close PeerConnection cleanly
     */
    function closePeerConnection(clearPendingQueue = true) {
        if (adaptationInterval) clearInterval(adaptationInterval);
        adaptationInterval = null;
        lastOutboundBytes = null;
        lastOutboundTimestamp = null;
        if (peerConnection) {
            peerConnection.ontrack = null;
            peerConnection.onicecandidate = null;
            peerConnection.onconnectionstatechange = null;
            peerConnection.oniceconnectionstatechange = null;
            peerConnection.onsignalingstatechange = null;
            peerConnection.onicegatheringstatechange = null;
            try {
                peerConnection.close();
            } catch (e) {
                console.warn('[WebRTC] Error closing peer connection:', e);
            }
            peerConnection = null;
            console.log('[WebRTC] PeerConnection closed');
        }
        if (clearPendingQueue) {
            pendingIceCandidates = [];
        }
        isNegotiating = false;
        hasQueuedNegotiation = false;
    }

    // =========================================================================
    // PHONE SENDER WORKFLOW
    // =========================================================================

    /**
     * Start phone camera streaming:
     * 1. Connect and REGISTER with signaling server (wait until registered!)
     * 2. Initiate SDP Offer once signaling is verified ready
     */
    async function startPhoneStreaming(stream) {
        localStream = stream;
        currentRole = 'PHONE';
        qualityLevel = 0;
        await loadRTCConfiguration();

        const sessionId = window.WomenSafetyConfig.getDefaultSessionId();
        const deviceId = 'phone-1';

        // 1. Initialize Signaling Client if not yet created
        if (!signalingClient) {
            signalingClient = new window.SignalingClient({
                role: 'PHONE',
                sessionId: sessionId,
                deviceId: deviceId
            });

            signalingClient.onStatusChange = (status) => {
                const connEl = document.getElementById('connectionStatus') || document.getElementById('webrtcStatus');
                if (connEl && (!peerConnection || peerConnection.connectionState !== 'connected')) {
                    connEl.textContent = status;
                }
            };

            signalingClient.onAnswer = async (answer) => {
                console.log('[WebRTC] ANSWER received');
                if (peerConnection) {
                    try {
                        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                        console.log('[WebRTC] Remote description set');
                        await flushPendingIceCandidates();
                    } catch (err) {
                        console.error('[WebRTC] Error setting remote description for answer:', err);
                    }
                } else {
                    console.warn('[WebRTC] Received ANSWER but peerConnection is null');
                }
            };

            signalingClient.onIceCandidate = async (candidate) => {
                await addIceCandidateSafely(candidate);
            };

            signalingClient.onRequestOffer = async () => {
                console.log('[WS] Dashboard requested fresh offer, re-offering...');
                if (localStream) {
                    initiatePhoneOffer(true);
                }
            };

            signalingClient.onPeerConnected = (info) => {
                const peerId = (info && info.deviceId) || 'dashboard-1';
                console.log(`[WS] Peer connected: ${peerId}`);
                // When a dashboard connects and stream is active, initiate negotiation
                if (localStream) {
                    initiatePhoneOffer();
                }
            };
        }

        // 2. WAIT UNTIL SIGNALING CLIENT IS FULLY REGISTERED
        console.log('[WebRTC] Waiting for signaling client to be registered before creating offer...');
        try {
            await signalingClient.connect();
            console.log('[WebRTC] Signaling client is registered. Initiating offer...');
            await initiatePhoneOffer();
        } catch (err) {
            console.error('[WebRTC] Failed to connect signaling client:', err);
            updateUIForConnectionState('failed');
        }
    }

    /**
     * Create and send SDP Offer from Phone to Dashboard
     */
    async function initiatePhoneOffer(iceRestart = false) {
        if (!localStream) {
            console.warn('[WebRTC] Cannot initiate offer: local camera stream is missing');
            return;
        }

        // Concurrency Guard: prevent duplicate simultaneous offers
        if (isNegotiating) {
            console.log('[WebRTC] Negotiation already in progress, queuing request...');
            hasQueuedNegotiation = true;
            return;
        }

        isNegotiating = true;

        try {
            await loadRTCConfiguration(iceRestart);
            if (iceRestart && peerConnection && peerConnection.setConfiguration) {
                peerConnection.setConfiguration(RTC_CONFIGURATION);
            }
            // Re-create peer connection if null or in terminal state
            if (!peerConnection || peerConnection.connectionState === 'closed' || peerConnection.connectionState === 'failed') {
                createPeerConnection('PHONE');
                iceRestart = false;
            }

            // Ensure video tracks are added
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                const senders = peerConnection.getSenders();
                const existingSender = senders.find(s => s.track && s.track.kind === 'video');
                if (!existingSender) {
                    peerConnection.addTrack(videoTrack, localStream);
                    console.log('[WebRTC] Camera track added');
                    await configureSenderParameters(peerConnection, videoTrack);
                }
            }

            console.log('[WebRTC] Creating offer');
            const offer = await peerConnection.createOffer(iceRestart ? { iceRestart: true } : undefined);
            await peerConnection.setLocalDescription(offer);
            console.log('[WebRTC] Local description set');

            // Send offer via signaling server (safe queued send if socket temporarily buffering)
            signalingClient.sendOffer(offer);
            startAdaptiveStreaming();

        } catch (err) {
            console.error('[WebRTC] Failed to initiate phone offer:', err);
        } finally {
            isNegotiating = false;
            if (hasQueuedNegotiation) {
                hasQueuedNegotiation = false;
                setTimeout(() => initiatePhoneOffer(), 150);
            }
        }
    }

    /**
     * Stop Phone Camera Streaming and notify signaling server
     */
    function stopPhoneStreaming() {
        if (signalingClient) {
            signalingClient.sendStreamStopped();
            signalingClient.disconnect();
            signalingClient = null;
        }

        closePeerConnection(true);
        localStream = null;
        updateUIForConnectionState('closed');
    }

    // =========================================================================
    // LAPTOP DASHBOARD RECEIVER WORKFLOW
    // =========================================================================

    /**
     * Initialize Dashboard Receiver node
     */
    function initDashboardReceiver() {
        currentRole = 'DASHBOARD';
        const sessionId = window.WomenSafetyConfig.getDefaultSessionId();
        const deviceId = 'dashboard-1';

        resetDashboardUI('Waiting for phone camera...');

        if (!signalingClient) {
            signalingClient = new window.SignalingClient({
                role: 'DASHBOARD',
                sessionId: sessionId,
                deviceId: deviceId
            });

            signalingClient.onStatusChange = (status) => {
                const sBadge = document.getElementById('server-status-badge');
                if (sBadge) {
                    sBadge.innerHTML = `<span class="badge-dot"></span> Signaling: ${status}`;
                }
            };

            // Process incoming SDP Offer from Phone
            signalingClient.onOffer = async (offer, fromDeviceId) => {
                console.log(`[WebRTC] OFFER received from ${fromDeviceId || 'phone-1'}`);
                activePhoneDeviceId = fromDeviceId || 'phone-1';

                try {
                    await loadRTCConfiguration(true);
                    updateUIForConnectionState('connecting');

                    // If existing connection is closed or failed, recreate
                    if (!peerConnection || peerConnection.connectionState === 'closed' || peerConnection.connectionState === 'failed') {
                        createPeerConnection('DASHBOARD');
                    }

                    // 1. Set Remote Description (Offer)
                    console.log('[WebRTC] Setting remote description (offer)...');
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
                    console.log('[WebRTC] Remote description set');

                    // 2. Flush queued early ICE candidates
                    await flushPendingIceCandidates();

                    // 3. Create Answer
                    console.log('[WebRTC] Creating answer');
                    const answer = await peerConnection.createAnswer();

                    // 4. Set Local Description (Answer)
                    await peerConnection.setLocalDescription(answer);
                    console.log('[WebRTC] Local description set');

                    // 5. Send Answer to Phone
                    signalingClient.sendAnswer(answer, activePhoneDeviceId);

                } catch (err) {
                    console.error('[WebRTC] Error during offer-answer negotiation on dashboard:', err);
                    resetDashboardUI('Failed to establish WebRTC connection: ' + (err.message || 'Negotiation error'));
                }
            };

            signalingClient.onIceCandidate = async (candidate) => {
                await addIceCandidateSafely(candidate);
            };

            signalingClient.onPeerConnected = (info) => {
                const peerId = (info && info.deviceId) || 'phone-1';
                console.log(`[WS] Peer connected: ${peerId}`);
                activePhoneDeviceId = peerId;
                const statDevice = document.getElementById('stat-device');
                if (statDevice) statDevice.textContent = activePhoneDeviceId;
            };

            signalingClient.onPeerDisconnected = (info) => {
                const peerId = (info && info.deviceId) || 'phone-1';
                console.log(`[WS] Peer disconnected: ${peerId}`);
                resetDashboardUI('Phone camera disconnected.');
                closePeerConnection(true);
            };

            // Connect signaling client for dashboard
            signalingClient.connect().then(() => {
                console.log('[WS] Waiting for phone...');
            }).catch(err => {
                console.warn('[WS] Dashboard signaling initial connect error:', err.message);
            });
        }

        // Setup dashboard UI controls
        setupDashboardControls();
    }

    /**
     * Dashboard interactive controls (Fullscreen, Mute, Disconnect, Reconnect)
     */
    function setupDashboardControls() {
        const fullscreenBtn = document.getElementById('btn-fullscreen');
        const muteBtn = document.getElementById('btn-mute');
        const disconnectBtn = document.getElementById('btn-disconnect');
        const reconnectBtn = document.getElementById('btn-reconnect');
        const remoteVideo = document.getElementById('remoteVideo');
        const streamContainer = document.getElementById('video-stream-container-01');

        if (fullscreenBtn && streamContainer) {
            fullscreenBtn.addEventListener('click', () => {
                if (!document.fullscreenElement) {
                    streamContainer.requestFullscreen().catch(err => {
                        console.warn('Fullscreen request failed:', err);
                    });
                } else {
                    document.exitFullscreen();
                }
            });
        }

        if (muteBtn && remoteVideo) {
            muteBtn.addEventListener('click', () => {
                remoteVideo.muted = !remoteVideo.muted;
                muteBtn.textContent = remoteVideo.muted ? 'Unmute' : 'Mute';
            });
        }

        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', () => {
                console.log('[WebRTC] User clicked disconnect.');
                closePeerConnection(true);
                resetDashboardUI('Disconnected by user.');
            });
        }

        if (reconnectBtn) {
            reconnectBtn.addEventListener('click', () => {
                console.log('[WebRTC] User clicked reconnect.');
                resetDashboardUI('Reconnecting to phone camera...');
                if (signalingClient && signalingClient.isConnected) {
                    signalingClient.sendRaw({
                        type: 'REQUEST_OFFER',
                        sessionId: signalingClient.sessionId,
                        role: 'DASHBOARD',
                        deviceId: signalingClient.deviceId
                    });
                }
            });
        }
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function init() {
        // Detect Dashboard Page
        if (document.getElementById('remoteVideo')) {
            initDashboardReceiver();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Public API
    window.WomenSafetyWebRTC = {
        startPhoneStreaming: startPhoneStreaming,
        stopPhoneStreaming: stopPhoneStreaming,
        createPeerConnection: createPeerConnection,
        closePeerConnection: closePeerConnection,
        getPeerConnection: () => peerConnection,
        getRemoteStream: () => remoteStream,
        getLocalStream: () => localStream,
        getSignalingClient: () => signalingClient
    };

})();
