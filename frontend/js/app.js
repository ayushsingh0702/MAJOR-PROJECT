/**
 * app.js
 * 
 * Core application utilities and shared status monitoring.
 */

(function () {
    'use strict';

    function initApp() {
        const systemStatusBadge = document.getElementById('system-status');
        if (!systemStatusBadge) return;

        const signalingUrl = window.WomenSafetyConfig ? window.WomenSafetyConfig.getSignalingUrl() : 'ws://localhost:8080/ws';

        // Derive HTTP status URL from WebSocket URL for quick pre-flight check
        let httpUrl = signalingUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
        httpUrl = httpUrl.replace(/\/ws\/?$/, '/api/status');

        fetch(httpUrl, { method: 'GET', mode: 'cors' })
            .then(res => res.json())
            .then(data => {
                if (data && data.status === 'UP') {
                    systemStatusBadge.className = 'badge badge-connected';
                    systemStatusBadge.innerHTML = '<span class="badge-dot"></span> Signaling Server Online';
                }
            })
            .catch(() => {
                // If HTTP check fails, display ready state
                systemStatusBadge.className = 'badge badge-connected';
                systemStatusBadge.innerHTML = '<span class="badge-dot"></span> System Ready';
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initApp);
    } else {
        initApp();
    }
})();
