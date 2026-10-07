/**
 * camera.js
 * 
 * Phone Camera Capture & Hardware Stream Management.
 * - Handles camera permissions and error messaging
 * - Requests rear/environment camera with 1080p @ 30fps and 720p fallback
 * - Displays local camera preview
 * - Tracks actual hardware resolution & FPS
 * - Coordinates with webrtc.js for live WebRTC streaming
 */

(function () {
    'use strict';

    function initCameraModule() {
        // DOM Elements
        const startBtn = document.getElementById('startBtn') || document.getElementById('btn-start-camera');
        const stopBtn = document.getElementById('stopBtn') || document.getElementById('btn-stop-camera');
        const cameraPreview = document.getElementById('cameraPreview');
        const cameraPlaceholder = document.getElementById('cameraPlaceholder');
        const cameraStatusEl = document.getElementById('cameraStatus');
        const connectionStatusEl = document.getElementById('connectionStatus') || document.getElementById('webrtcStatus');
        const resDisplayEl = document.getElementById('cameraResolutionDisplay');
        const fpsDisplayEl = document.getElementById('cameraFpsDisplay');
        const qualityDisplayEl = document.getElementById('cameraQualityDisplay');
        const errorMessageEl = document.getElementById('errorMessage');
        const debugCameraEl = document.getElementById('debugCamera');

        // State
        let currentStream = null;
        let activeSettings = null;

        function setCameraStatus(text, className) {
            if (cameraStatusEl) {
                cameraStatusEl.textContent = text;
                cameraStatusEl.className = 'camera-status ' + (className || '');
            }
        }

        function setConnectionStatus(text, badgeClass) {
            if (connectionStatusEl) {
                connectionStatusEl.textContent = text;
                if (badgeClass) {
                    connectionStatusEl.className = 'badge ' + badgeClass;
                }
            }
        }

        function showError(message) {
            if (errorMessageEl) {
                errorMessageEl.textContent = message;
                errorMessageEl.style.display = 'block';
            }
        }

        function clearError() {
            if (errorMessageEl) {
                errorMessageEl.textContent = '';
                errorMessageEl.style.display = 'none';
            }
        }

        function updateStatsDisplay(settings) {
            if (!settings || !settings.width) {
                if (resDisplayEl) resDisplayEl.textContent = '--';
                if (fpsDisplayEl) fpsDisplayEl.textContent = '--';
                if (qualityDisplayEl) qualityDisplayEl.textContent = '--';
                if (debugCameraEl) debugCameraEl.textContent = 'Not started';
                return;
            }

            const width = settings.width;
            const height = settings.height;
            const fps = Math.round(settings.frameRate || 30);

            if (resDisplayEl) resDisplayEl.textContent = `${width} × ${height}`;
            if (fpsDisplayEl) fpsDisplayEl.textContent = `${fps} FPS`;
            if (qualityDisplayEl) {
                qualityDisplayEl.textContent = (height >= 1080 ? 'Excellent' : (height >= 720 ? 'Good' : 'Standard'));
            }
            if (debugCameraEl) {
                debugCameraEl.textContent = `${width} × ${height} @ ${fps} FPS`;
            }
        }

        /**
         * Acquire camera stream with 1080p -> 720p adaptive fallback
         */
        async function acquireCameraStream() {
            // Target constraints: 1080p @ 30 FPS rear camera
            const primaryConstraints = {
                video: {
                    facingMode: { ideal: "environment" },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    frameRate: { ideal: 30, max: 30 }
                },
                audio: false
            };

            // Fallback 1: 720p @ 30 FPS rear camera
            const fallback720pConstraints = {
                video: {
                    facingMode: { ideal: "environment" },
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30, max: 30 }
                },
                audio: false
            };

            // Fallback 2: Basic video
            const standardConstraints = {
                video: { facingMode: { ideal: "environment" } },
                audio: false
            };

            try {
                return await navigator.mediaDevices.getUserMedia(primaryConstraints);
            } catch (err1) {
                console.warn('[Camera] 1080p constraints could not be satisfied, attempting 720p fallback:', err1.name);
                try {
                    return await navigator.mediaDevices.getUserMedia(fallback720pConstraints);
                } catch (err2) {
                    console.warn('[Camera] 720p constraints failed, attempting generic video fallback:', err2.name);
                    return await navigator.mediaDevices.getUserMedia(standardConstraints);
                }
            }
        }

        /**
         * Start camera action
         */
        async function startCamera() {
            clearError();

            if (startBtn) startBtn.disabled = true;

            // Check browser support
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                showError("Unable to access camera. WebRTC and MediaDevices APIs require a secure context (HTTPS / localhost).");
                if (startBtn) startBtn.disabled = false;
                setCameraStatus("● Camera Unavailable", "status-offline");
                return;
            }

            setCameraStatus("Initializing Camera...", "status-offline");
            setConnectionStatus("Camera Permission Required", "status-waiting");

            try {
                const stream = await acquireCameraStream();
                currentStream = stream;

                // Inspect track settings
                const videoTrack = stream.getVideoTracks()[0];
                if (videoTrack) {
                    activeSettings = videoTrack.getSettings ? videoTrack.getSettings() : {};
                    console.log("[Camera] Stream acquired:", activeSettings);
                    updateStatsDisplay(activeSettings);

                    videoTrack.addEventListener('ended', () => {
                        console.log("[Camera] Track ended by hardware/system");
                        stopCamera();
                    });
                }

                // Show preview
                if (cameraPreview) {
                    cameraPreview.srcObject = stream;
                    cameraPreview.style.display = 'block';
                    try {
                        await cameraPreview.play();
                    } catch (playErr) {
                        console.warn("[Camera] Autoplay promise:", playErr);
                    }
                }

                if (cameraPlaceholder) {
                    cameraPlaceholder.style.display = 'none';
                }

                setCameraStatus("● Camera Ready", "status-active");
                setConnectionStatus("Connecting...", "status-connecting");

                if (startBtn) startBtn.disabled = true;
                if (stopBtn) stopBtn.disabled = false;

                // Notify WebRTC subsystem to start WebRTC streaming over Spring Boot signaling
                if (window.WomenSafetyWebRTC && window.WomenSafetyWebRTC.startPhoneStreaming) {
                    window.WomenSafetyWebRTC.startPhoneStreaming(stream);
                } else {
                    window.dispatchEvent(new CustomEvent('womensafety:camera-started', {
                        detail: { stream: stream, track: videoTrack, settings: activeSettings }
                    }));
                }

            } catch (err) {
                console.error("[Camera] Access error:", err);

                if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                    showError("Camera permission is required to start streaming.");
                    setCameraStatus("● Permission Denied", "status-offline");
                    setConnectionStatus("Permission Denied", "badge-disconnected");
                } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                    showError("Unable to access camera: No camera device found.");
                    setCameraStatus("● No Camera Found", "status-offline");
                } else {
                    showError("Unable to access camera: " + (err.message || 'Unknown error'));
                    setCameraStatus("● Camera Error", "status-offline");
                }

                if (startBtn) startBtn.disabled = false;
                if (stopBtn) stopBtn.disabled = true;
                updateStatsDisplay(null);
            }
        }

        /**
         * Stop camera action
         */
        function stopCamera() {
            clearError();

            // 1. Stop all tracks
            if (currentStream) {
                currentStream.getTracks().forEach(track => {
                    track.stop();
                });
                currentStream = null;
            }

            activeSettings = null;
            updateStatsDisplay(null);

            // 2. Clear video element
            if (cameraPreview) {
                cameraPreview.srcObject = null;
                cameraPreview.style.display = 'none';
            }

            // 3. Show placeholder
            if (cameraPlaceholder) {
                cameraPlaceholder.style.display = 'flex';
            }

            // 4. Update status displays
            setCameraStatus("● Camera Offline", "status-offline");
            setConnectionStatus("Waiting", "status-waiting");

            // 5. Update buttons
            if (startBtn) startBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;

            // 6. Tear down WebRTC session & notify signaling server
            if (window.WomenSafetyWebRTC && window.WomenSafetyWebRTC.stopPhoneStreaming) {
                window.WomenSafetyWebRTC.stopPhoneStreaming();
            } else {
                window.dispatchEvent(new CustomEvent('womensafety:camera-stopped'));
            }
        }

        // Attach listeners
        if (startBtn) {
            startBtn.addEventListener('click', startCamera);
        }

        if (stopBtn) {
            stopBtn.addEventListener('click', stopCamera);
        }

        window.addEventListener('beforeunload', () => {
            if (currentStream) {
                currentStream.getTracks().forEach(t => t.stop());
            }
        });

        // Public API
        window.WomenSafetyCamera = {
            startCamera: startCamera,
            stopCamera: stopCamera,
            getStream: () => currentStream,
            getSettings: () => activeSettings
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCameraModule);
    } else {
        initCameraModule();
    }
})();
