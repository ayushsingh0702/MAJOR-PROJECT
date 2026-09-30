/**
 * camera.js
 * 
 * Phase 2: High-Quality Local Camera Access & Track Inspection
 * 
 * Handles:
 * - High-resolution camera constraints (ideal 1080p @ 30fps with automatic 720p fallback)
 * - Rear facing camera preference (ideal: "environment")
 * - Inspecting actual hardware stream settings via track.getSettings()
 * - Logging actual width, height, frameRate, facingMode
 * - Displaying actual selected resolution in development/debug UI
 * - Coordinating with webrtc.js via custom events and public API
 */

(function () {
    'use strict';

    function initCamera() {
        // DOM Elements
        const startBtn = document.getElementById('startBtn') || document.getElementById('btn-start-camera');
        const stopBtn = document.getElementById('stopBtn') || document.getElementById('btn-stop-camera');
        const cameraPreview = document.getElementById('cameraPreview');
        const cameraPlaceholder = document.getElementById('cameraPlaceholder') || document.getElementById('camera-placeholder');
        const cameraStatus = document.getElementById('cameraStatus') || document.getElementById('camera-stream-badge');
        const errorMessage = document.getElementById('errorMessage') || document.getElementById('error-message');
        const debugCameraEl = document.getElementById('debugCamera');

        // State
        let currentStream = null;
        let activeSettings = null;

        /**
         * Display an error message in the error area
         */
        function showError(message) {
            if (errorMessage) {
                errorMessage.textContent = message;
                errorMessage.style.display = 'block';
            }
        }

        /**
         * Clear and hide the error message area
         */
        function clearError() {
            if (errorMessage) {
                errorMessage.textContent = '';
                errorMessage.style.display = 'none';
            }
        }

        /**
         * Update the debug UI with active camera resolution and settings
         */
        function updateCameraDebugInfo(settings) {
            if (!debugCameraEl) return;
            if (!settings || !settings.width) {
                debugCameraEl.textContent = 'Camera: Not started';
                return;
            }
            const width = settings.width;
            const height = settings.height;
            const fps = Math.round(settings.frameRate || 30);
            debugCameraEl.textContent = `Camera: ${width} × ${height} @ ${fps} FPS`;
        }

        /**
         * Start high-quality camera stream
         */
        async function startCamera() {
            clearError();

            if (startBtn) {
                startBtn.disabled = true;
            }

            // Check if MediaDevices API is available
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                console.error("Camera API Error: navigator.mediaDevices.getUserMedia is not supported or not running in a secure context (HTTPS / localhost).");
                showError("Unable to access the camera.");
                if (startBtn) {
                    startBtn.disabled = false;
                }
                return;
            }

            // High-quality camera configuration with ideal constraints for graceful adaptation
            const constraints = {
                video: {
                    facingMode: {
                        ideal: "environment"
                    },
                    width: {
                        ideal: 1920
                    },
                    height: {
                        ideal: 1080
                    },
                    frameRate: {
                        ideal: 30,
                        max: 30
                    }
                },
                audio: false
            };

            try {
                let stream;
                try {
                    // 1. Request camera permission & start camera with target constraints
                    stream = await navigator.mediaDevices.getUserMedia(constraints);
                } catch (constraintErr) {
                    // Fallback for development/testing if browser/webcam strictly errors on ideal constraints
                    if (constraintErr.name === 'OverconstrainedError') {
                        console.warn("Camera ideal constraints overconstrained, falling back to standard video device:", constraintErr);
                        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    } else {
                        throw constraintErr;
                    }
                }

                // 2. Store MediaStream
                currentStream = stream;

                // 3. Inspect stream settings
                const videoTrack = stream.getVideoTracks()[0];
                if (videoTrack) {
                    activeSettings = videoTrack.getSettings ? videoTrack.getSettings() : {};
                    console.log("=== Active Camera Stream Acquired ===");
                    console.log(`- Width:       ${activeSettings.width || 'Unknown'} px`);
                    console.log(`- Height:      ${activeSettings.height || 'Unknown'} px`);
                    console.log(`- FrameRate:   ${activeSettings.frameRate || 'Unknown'} FPS`);
                    console.log(`- FacingMode:  ${activeSettings.facingMode || 'Unknown'}`);
                    updateCameraDebugInfo(activeSettings);
                }

                // 4. Assign it to cameraPreview.srcObject
                if (cameraPreview) {
                    cameraPreview.srcObject = stream;
                    cameraPreview.style.display = 'block';
                    try {
                        await cameraPreview.play();
                    } catch (playErr) {
                        console.warn("Video play promise note:", playErr);
                    }
                }

                // 5. Hide "Camera is not started" placeholder
                if (cameraPlaceholder) {
                    cameraPlaceholder.style.display = 'none';
                }

                // 6. Change status to: "● Camera Active"
                if (cameraStatus) {
                    cameraStatus.textContent = '● Camera Active';
                    cameraStatus.classList.remove('status-offline');
                    cameraStatus.classList.add('status-active');
                }

                // 7 & 8. Disable Start Camera, Enable Stop Camera
                if (startBtn) {
                    startBtn.disabled = true;
                }
                if (stopBtn) {
                    stopBtn.disabled = false;
                }

                // Notify external modules (e.g. webrtc.js) that camera stream is live
                window.dispatchEvent(new CustomEvent('womensafety:camera-started', {
                    detail: {
                        stream: stream,
                        track: videoTrack,
                        settings: activeSettings
                    }
                }));

                // Handle external stream interruption
                videoTrack.addEventListener('ended', () => {
                    stopCamera();
                });

            } catch (err) {
                // Log technical error
                console.error("Camera access error:", err);

                // Handle specific errors as required
                if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                    showError("Camera permission was denied.");
                } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                    showError("No camera was found.");
                } else {
                    showError("Unable to access the camera.");
                }

                // Reset UI state
                if (currentStream) {
                    currentStream.getTracks().forEach(t => t.stop());
                    currentStream = null;
                }

                activeSettings = null;
                updateCameraDebugInfo(null);

                if (cameraPreview) {
                    cameraPreview.srcObject = null;
                    cameraPreview.style.display = 'none';
                }

                if (cameraPlaceholder) {
                    cameraPlaceholder.style.display = 'flex';
                }

                if (cameraStatus) {
                    cameraStatus.textContent = '● Camera Offline';
                    cameraStatus.classList.remove('status-active');
                    cameraStatus.classList.add('status-offline');
                }

                if (startBtn) {
                    startBtn.disabled = false;
                }
                if (stopBtn) {
                    stopBtn.disabled = true;
                }
            }
        }

        /**
         * Stop camera stream
         */
        function stopCamera() {
            clearError();

            // 1. Stop every MediaStream track
            if (currentStream) {
                currentStream.getTracks().forEach(track => {
                    track.stop();
                });
                currentStream = null;
            }

            activeSettings = null;
            updateCameraDebugInfo(null);

            // 2. Set the video srcObject to null
            if (cameraPreview) {
                cameraPreview.srcObject = null;
                cameraPreview.style.display = 'none';
            }

            // 3. Show "Camera is not started"
            if (cameraPlaceholder) {
                cameraPlaceholder.style.display = 'flex';
            }

            // 4. Change status to: "● Camera Offline"
            if (cameraStatus) {
                cameraStatus.textContent = '● Camera Offline';
                cameraStatus.classList.remove('status-active');
                cameraStatus.classList.add('status-offline');
            }

            // 5. Enable Start Camera
            if (startBtn) {
                startBtn.disabled = false;
            }

            // 6. Disable Stop Camera
            if (stopBtn) {
                stopBtn.disabled = true;
            }

            // Notify WebRTC module that camera stopped
            window.dispatchEvent(new CustomEvent('womensafety:camera-stopped'));
        }

        // Attach listeners
        if (startBtn) {
            startBtn.addEventListener('click', startCamera);
        }

        if (stopBtn) {
            stopBtn.addEventListener('click', stopCamera);
        }

        // Clean up tracks on page unload
        window.addEventListener('beforeunload', () => {
            if (currentStream) {
                currentStream.getTracks().forEach(track => track.stop());
            }
        });

        // Expose public camera API
        window.WomenSafetyCamera = {
            startCamera: startCamera,
            stopCamera: stopCamera,
            getStream: () => currentStream,
            getSettings: () => activeSettings
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCamera);
    } else {
        initCamera();
    }
})();
