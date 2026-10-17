/**
 * ai-client.js
 * 
 * Non-blocking client for the Women Safety AI microservice.
 * Samples frames from remote video without interrupting WebRTC playback.
 */

(function () {
    'use strict';

    class AIAnalysisClient {
        constructor() {
            this.active = false;
            this.intervalId = null;
            this.samplingIntervalMs = 1200; // ~0.83 frames/sec to preserve CPU responsiveness
            this.isProcessingFrame = false;
            this.canvas = document.createElement('canvas');
            this.ctx = this.canvas.getContext('2d');
            this.history = [];
            this.maxHistory = 10;
            this.consecutiveHarassmentDetections = 0;
            this.thresholdAlertCount = 3; // Temporal smoothing threshold

            // Callbacks
            this.onStatusChange = null;
            this.onResult = null;
            this.onError = null;
        }

        getBaseUrl() {
            if (window.WomenSafetyConfig && typeof window.WomenSafetyConfig.getAiServiceUrl === 'function') {
                return window.WomenSafetyConfig.getAiServiceUrl();
            }
            return 'http://127.0.0.1:8000';
        }

        async checkHealth() {
            const baseUrl = this.getBaseUrl();
            if (window.location.protocol === 'https:' && baseUrl.startsWith('http://')) {
                throw new Error('Mixed Content Block: Browser blocks HTTP AI service calls from HTTPS frontend. Provide an HTTPS endpoint (e.g. Cloudflare tunnel or cloud URL).');
            }
            const res = await fetch(`${baseUrl}/health`, { method: 'GET', cache: 'no-store' });
            if (!res.ok) throw new Error(`Health check returned status ${res.status}`);
            return await res.json();
        }

        async checkModelStatus() {
            const baseUrl = this.getBaseUrl();
            if (window.location.protocol === 'https:' && baseUrl.startsWith('http://')) {
                throw new Error('Mixed Content: Provide an HTTPS AI endpoint for this deployed dashboard.');
            }
            const res = await fetch(`${baseUrl}/models/status`, { method: 'GET', cache: 'no-store' });
            if (!res.ok) throw new Error(`Model status check returned status ${res.status}`);
            return await res.json();
        }

        start(videoElement) {
            if (this.active) return;
            if (!videoElement) {
                if (this.onError) this.onError('Cannot start AI analysis: Remote video element not found.');
                return;
            }

            this.active = true;
            if (this.onStatusChange) this.onStatusChange('RUNNING', 'AI sampling started');

            this.intervalId = setInterval(() => {
                this._sampleAndSendFrame(videoElement);
            }, this.samplingIntervalMs);

            // Trigger immediate first sample
            this._sampleAndSendFrame(videoElement);
        }

        stop(reason = 'User stopped') {
            if (!this.active) return;
            this.active = false;
            if (this.intervalId) {
                clearInterval(this.intervalId);
                this.intervalId = null;
            }
            this.isProcessingFrame = false;
            this.consecutiveHarassmentDetections = 0;
            if (this.onStatusChange) this.onStatusChange('STOPPED', reason);
        }

        _sampleAndSendFrame(videoElement) {
            if (!this.active) return;
            if (this.isProcessingFrame) {
                // Skip if previous inference is still in-flight
                return;
            }

            // Ensure video element is playing with valid dimensions
            const w = videoElement.videoWidth;
            const h = videoElement.videoHeight;
            if (!w || !h || videoElement.paused || videoElement.ended || videoElement.readyState < 2) {
                // Stream not yet ready or paused
                return;
            }

            this.isProcessingFrame = true;

            try {
                // Resize frame to 224x224 directly on client canvas for fast network transfer
                this.canvas.width = 224;
                this.canvas.height = 224;
                this.ctx.drawImage(videoElement, 0, 0, 224, 224);

                this.canvas.toBlob(async (blob) => {
                    if (!blob || !this.active) {
                        this.isProcessingFrame = false;
                        return;
                    }

                    const formData = new FormData();
                    formData.append('file', blob, 'frame.jpg');

                    try {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 6000); // 6s timeout

                        const baseUrl = this.getBaseUrl();
                        const response = await fetch(`${baseUrl}/predict/harassment`, {
                            method: 'POST',
                            body: formData,
                            signal: controller.signal
                        });

                        clearTimeout(timeout);

                        if (!response.ok) {
                            const errBody = await response.text();
                            throw new Error(`Inference HTTP ${response.status}: ${errBody}`);
                        }

                        const result = await response.json();
                        this._handleInferenceResult(result);
                    } catch (err) {
                        if (this.active) {
                            console.warn('[AI Client] Frame inference error:', err.message);
                            if (this.onError) this.onError(err.message);
                        }
                    } finally {
                        this.isProcessingFrame = false;
                    }
                }, 'image/jpeg', 0.85);
            } catch (err) {
                console.error('[AI Client] Canvas sampling error:', err);
                this.isProcessingFrame = false;
            }
        }

        _handleInferenceResult(result) {
            if (!this.active) return;

            // Maintain history
            this.history.unshift(result);
            if (this.history.length > this.maxHistory) {
                this.history.pop();
            }

            // Check prediction (handling both LABEL_1 and raw scores)
            const isAlertCandidate = (result.prediction === 'LABEL_1' || result.prediction === 'harassment');
            if (isAlertCandidate && result.confidence >= 0.70) {
                this.consecutiveHarassmentDetections++;
            } else {
                this.consecutiveHarassmentDetections = Math.max(0, this.consecutiveHarassmentDetections - 1);
            }

            const alertState = {
                consecutiveCount: this.consecutiveHarassmentDetections,
                isAggregatedAlert: this.consecutiveHarassmentDetections >= this.thresholdAlertCount
            };

            if (this.onResult) {
                this.onResult(result, alertState, this.history);
            }
        }
    }

    window.AIAnalysisClient = AIAnalysisClient;
})();
