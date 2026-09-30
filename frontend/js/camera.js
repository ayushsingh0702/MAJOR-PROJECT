/**
 * camera.js
 * 
 * Phase 1: Local Mobile Camera Access
 * 
 * Handles:
 * - Requesting camera permission via navigator.mediaDevices.getUserMedia()
 * - Environment (rear) facing camera preference with desktop fallback
 * - Streaming video to <video id="cameraPreview">
 * - Starting and stopping media tracks cleanly
 * - Updating UI status ("● Camera Offline" <-> "● Camera Active")
 * - Handling permission, device not found, and general access errors
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

        // State
        let currentStream = null;

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
         * Start camera stream
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

            // Camera constraints as specified
            const constraints = {
                video: {
                    facingMode: "environment"
                },
                audio: false
            };

            try {
                let stream;
                try {
                    // 1. Request camera permission & start camera
                    stream = await navigator.mediaDevices.getUserMedia(constraints);
                } catch (constraintErr) {
                    // Fallback for desktop testing where environment camera is unavailable
                    if (constraintErr.name === 'OverconstrainedError') {
                        console.warn("Camera facingMode 'environment' not satisfied, falling back to default camera device:", constraintErr);
                        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    } else {
                        throw constraintErr;
                    }
                }

                // 2 & 3. Store the MediaStream
                currentStream = stream;

                // 4. Assign it to cameraPreview.srcObject
                if (cameraPreview) {
                    cameraPreview.srcObject = stream;
                    cameraPreview.style.display = 'block';
                    try {
                        await cameraPreview.play();
                    } catch (playErr) {
                        console.warn("Video play promise error (can be ignored if autoplay handled):", playErr);
                    }
                }

                // 5. Hide "Camera is not started"
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

                // Handle external stream interruption (e.g., camera disconnected)
                stream.getTracks().forEach(track => {
                    track.addEventListener('ended', () => {
                        stopCamera();
                    });
                });

            } catch (err) {
                // Log technical errors to console
                console.error("Camera access error:", err);

                // Handle specific errors as required
                if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                    showError("Camera permission was denied.");
                } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                    showError("No camera was found.");
                } else {
                    showError("Unable to access the camera.");
                }

                // Clean up any partial state
                if (currentStream) {
                    currentStream.getTracks().forEach(t => t.stop());
                    currentStream = null;
                }

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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCamera);
    } else {
        initCamera();
    }
})();
