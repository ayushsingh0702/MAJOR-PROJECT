/**
 * webrtc.js
 * 
 * WebRTC Peer Connection & Real-Time Media Streaming Engine.
 * - Integrates with Spring Boot WebSocket signaling server
 * - Handles SDP Offer / Answer exchange
 * - Handles ICE Candidate discovery and candidate queuing
 * - High-quality adaptive video encoding parameters
 * - Remote video streaming for Laptop Dashboard
 */

(function () {
    'use strict';

    // Base WebRTC Configuration (STUN server list; ready for TURN additions)
    const RTC_CONFIGURATION = {
        iceServers: (window.WomenSafetyConfig && window.WomenSafetyConfig.getStunServers()) || [
            {
                urls: "stun:stun.l.google.com:19302"
            }
        ]
    };

    // State Variables
    let peerConnection = null;
    let signalingClient = null;
    let localStream = null;
    let remoteStream = null;
    let currentRole = null; // 'PHONE' or 'DASHBOARD'
    let pendingIceCandidates = [];
    let activePhoneDeviceId = 'Phone 1';
    let reconnectTimeout = null;

    /**
     * Check WebRTC support
     */
    function isWebRTCSupported() {
        return !!(window.RTCPeerConnection && window.RTCSessionDescription && window.RTCIceCandidate);
    }

    /**
     * Normalize and map WebRTC connection states
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
     * Configure RTCRtpSender encoding parameters for low latency and high quality
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

            const trackSettings = videoTrack.getSettings ? videoTrack.getSettings() : {};
            const height = trackSettings.height || 720;

            // Target bitrates: ~4.5 Mbps for 1080p, ~2.5 Mbps for 720p
            const targetBitrate = height >= 1080 ? 4500000 : (height >= 720 ? 2500000 : 1200000);
            parameters.encodings[0].maxBitrate = targetBitrate;
            parameters.encodings[0].maxFramerate = 30;

            if ('degradationPreference' in parameters) {
                parameters.degradationPreference = 'maintain-framerate';
            }

            await sender.setParameters(parameters);
            console.log(`[WebRTC] Video sender configured: maxBitrate=${(targetBitrate / 1000000).toFixed(1)} Mbps @ 30 FPS`);
        } catch (err) {
            console.warn('[WebRTC] Note on encoding parameters (non-critical):', err);
        }
    }

    /**
     * Create RTCPeerConnection instance
     */
    function createPeerConnection(role) {
        if (!isWebRTCSupported()) {
            throw new Error("Your browser does not support WebRTC APIs.");
        }

        if (peerConnection) {
            closePeerConnection();
        }

        currentRole = role;
        pendingIceCandidates = [];

        peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);
        console.log('[WebRTC] Peer connection created');

        // ICE Candidate Gathering
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('[WebRTC] ICE candidate generated');
                if (signalingClient) {
                    signalingClient.sendIceCandidate(event.candidate);
                }
            }
        };

        // Connection State Monitoring
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection ? peerConnection.connectionState : 'closed';
            console.log(`[WebRTC] Connection state: ${state}`);

            updateUIForConnectionState(state);

            if (state === 'failed') {
                console.warn('[WebRTC] Connection failed, attempting automatic reconnection in 2s...');
                scheduleReconnection();
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            const iceState = peerConnection ? peerConnection.iceConnectionState : 'closed';
            const debugIce = document.getElementById('debugICE') || document.getElementById('dashboard-debug-ice') || document.getElementById('dashboard-debug-ice-val');
            if (debugIce) {
                debugIce.textContent = iceState;
            }
        };

        // Remote Track Arrival (Laptop Dashboard)
        peerConnection.ontrack = (event) => {
            console.log('[WebRTC] Remote stream received');
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

        while (pendingIceCandidates.length > 0) {
            const candidate = pendingIceCandidates.shift();
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.warn('[WebRTC] Error adding queued ICE candidate:', err);
            }
        }
    }

    /**
     * Safely add ICE Candidate, queueing if remote description not yet set
     */
    async function addIceCandidateSafely(candidateInit) {
        if (!candidateInit) return;

        if (!peerConnection || !peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
            pendingIceCandidates.push(candidateInit);
            return;
        }

        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidateInit));
        } catch (err) {
            console.warn('[WebRTC] Failed to add ICE candidate:', err);
        }
    }

    /**
     * Update UI elements across Phone and Dashboard pages
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
                dashboardStatus.innerHTML = '<span class="badge-dot"></span> WAITING FOR CAMERA';
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
     * Bind remote stream to Dashboard UI
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

            remoteVideo.play().catch(e => console.warn('[WebRTC] Remote play promise:', e));

            remoteVideo.onloadedmetadata = () => {
                const w = remoteVideo.videoWidth;
                const h = remoteVideo.videoHeight;
                console.log(`[WebRTC] Remote video resolution: ${w} × ${h}`);
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
     * Reset dashboard UI back to "Waiting for phone camera..."
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
                startPhoneStreaming(localStream);
            } else if (currentRole === 'DASHBOARD') {
                if (signalingClient) {
                    signalingClient.sendRaw({
                        type: 'REQUEST_OFFER',
                        sessionId: signalingClient.sessionId,
                        role: 'DASHBOARD',
                        deviceId: signalingClient.deviceId
                    });
                }
            }
        }, 2000);
    }

    /**
     * Close PeerConnection
     */
    function closePeerConnection() {
        if (peerConnection) {
            peerConnection.ontrack = null;
            peerConnection.onicecandidate = null;
            peerConnection.onconnectionstatechange = null;
            peerConnection.close();
            peerConnection = null;
            console.log('[WebRTC] Peer connection closed');
        }
        pendingIceCandidates = [];
    }

    // =========================================================================
    // PHONE SENDER WORKFLOW
    // =========================================================================

    async function startPhoneStreaming(stream) {
        localStream = stream;
        currentRole = 'PHONE';

        const sessionId = window.WomenSafetyConfig.getDefaultSessionId();
        const deviceId = 'phone-1';

        // 1. Initialize Signaling Client if not yet connected
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
                console.log('[WebSocket] Answer received');
                if (peerConnection) {
                    try {
                        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                        await flushPendingIceCandidates();
                        console.log('[WebRTC] Remote answer applied successfully');
                    } catch (err) {
                        console.error('[WebRTC] Error setting remote description for answer:', err);
                    }
                }
            };

            signalingClient.onIceCandidate = async (candidate) => {
                await addIceCandidateSafely(candidate);
            };

            signalingClient.onRequestOffer = async () => {
                console.log('[WebRTC] Dashboard requested fresh offer, re-offering...');
                if (localStream) {
                    initiatePhoneOffer();
                }
            };

            signalingClient.onPeerConnected = (info) => {
                console.log('[WebRTC] Dashboard peer connected:', info);
                // When a dashboard connects, send a fresh offer immediately
                if (localStream) {
                    initiatePhoneOffer();
                }
            };

            signalingClient.connect();
        }

        // 2. Setup PeerConnection & tracks
        await initiatePhoneOffer();
    }

    async function initiatePhoneOffer() {
        if (!localStream) return;

        try {
            createPeerConnection('PHONE');

            // Add video tracks
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                peerConnection.addTrack(videoTrack, localStream);
                await configureSenderParameters(peerConnection, videoTrack);
            }

            // Create Offer
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            // Send offer via signaling server
            signalingClient.sendOffer(offer);

        } catch (err) {
            console.error('[WebRTC] Failed to initiate phone offer:', err);
        }
    }

    function stopPhoneStreaming() {
        if (signalingClient) {
            signalingClient.sendStreamStopped();
            signalingClient.disconnect();
            signalingClient = null;
        }

        closePeerConnection();
        localStream = null;
        updateUIForConnectionState('closed');
    }

    // =========================================================================
    // LAPTOP DASHBOARD RECEIVER WORKFLOW
    // =========================================================================

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

            signalingClient.onOffer = async (offer, fromDeviceId) => {
                console.log(`[WebRTC] Received offer from ${fromDeviceId}`);
                activePhoneDeviceId = fromDeviceId || 'Phone 1';

                try {
                    updateUIForConnectionState('connecting');

                    createPeerConnection('DASHBOARD');

                    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
                    await flushPendingIceCandidates();

                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);

                    signalingClient.sendAnswer(answer, fromDeviceId);

                } catch (err) {
                    console.error('[WebRTC] Error processing offer on dashboard:', err);
                    resetDashboardUI('Error establishing WebRTC connection.');
                }
            };

            signalingClient.onIceCandidate = async (candidate) => {
                await addIceCandidateSafely(candidate);
            };

            signalingClient.onPeerDisconnected = (info) => {
                console.log('[WebRTC] Phone peer disconnected:', info);
                resetDashboardUI('Phone disconnected.');
                closePeerConnection();
            };

            signalingClient.connect();
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
                closePeerConnection();
                resetDashboardUI('Disconnected by user.');
            });
        }

        if (reconnectBtn) {
            reconnectBtn.addEventListener('click', () => {
                console.log('[WebRTC] User clicked reconnect.');
                resetDashboardUI('Reconnecting to phone camera...');
                if (signalingClient) {
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
        getSignalingClient: () => signalingClient,
        // Snapshot helper: captures current video frame to canvas
        captureCurrentFrame: function (targetCanvas) {
            const video = document.getElementById('remoteVideo');
            if (!video || video.readyState < 2) return null;
            const canvas = targetCanvas || document.createElement('canvas');
            canvas.width = video.videoWidth || 1920;
            canvas.height = video.videoHeight || 1080;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            return canvas;
        }
    };

})();
