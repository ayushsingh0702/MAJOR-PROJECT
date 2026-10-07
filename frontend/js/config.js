/**
 * config.js
 * 
 * Application Configuration & Signaling URL Resolution.
 * Supports:
 * 1. Runtime environment variables (e.g. VITE_SIGNALING_URL via window.ENV_CONFIG)
 * 2. URL Query Parameter override (?ws=wss://YOUR-BACKEND/ws or ?server=YOUR-BACKEND)
 * 3. LocalStorage persistence (allows changing backend directly on mobile or laptop)
 * 4. Automatic protocol and host deduction for local/LAN testing
 */

(function () {
    'use strict';

    // Default configuration (can be updated for production deployment)
    const DEFAULT_CONFIG = {
        // In local development: ws://localhost:8080/ws
        // In production on HTTPS: replace or configure via window.ENV_CONFIG or query param ?ws=wss://...
        DEFAULT_WS_URL: 'ws://localhost:8080/ws',
        DEFAULT_SESSION_ID: 'default-session',
        STUN_SERVERS: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    };

    /**
     * Resolves the WebRTC signaling WebSocket URL dynamically.
     */
    function resolveSignalingUrl() {
        // 1. Check URL query parameters (?ws=... or ?signaling=...)
        try {
            const params = new URLSearchParams(window.location.search);
            const queryWs = params.get('ws') || params.get('signaling');
            if (queryWs) {
                console.log('[Config] Using signaling URL from query parameter:', queryWs);
                localStorage.setItem('VITE_SIGNALING_URL', queryWs);
                return queryWs;
            }
        } catch (e) {
            // Ignore URL search params error
        }

        // 2. Check window.ENV_CONFIG or window.VITE_SIGNALING_URL (injected during deployment)
        if (window.ENV_CONFIG && window.ENV_CONFIG.VITE_SIGNALING_URL) {
            return window.ENV_CONFIG.VITE_SIGNALING_URL;
        }
        if (window.VITE_SIGNALING_URL) {
            return window.VITE_SIGNALING_URL;
        }

        // 3. Check localStorage
        const storedUrl = localStorage.getItem('VITE_SIGNALING_URL');
        if (storedUrl) {
            return storedUrl;
        }

        // 4. Fallback based on current hostname
        const isHttps = window.location.protocol === 'https:';
        const hostname = window.location.hostname;

        // If running locally or on local LAN IP (e.g., 192.168.x.x)
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return `ws://${hostname}:8080/ws`;
        }

        if (hostname.match(/^192\.168\./) || hostname.match(/^10\./) || hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
            return `${isHttps ? 'wss:' : 'ws:'}//${hostname}:8080/ws`;
        }

        // 5. If deployed on Vercel without env, check if production backend domain is defined
        // Otherwise default to secure WebSocket template
        return DEFAULT_CONFIG.DEFAULT_WS_URL;
    }

    window.WomenSafetyConfig = {
        getSignalingUrl: resolveSignalingUrl,
        setSignalingUrl: function (url) {
            if (url) {
                localStorage.setItem('VITE_SIGNALING_URL', url.trim());
            } else {
                localStorage.removeItem('VITE_SIGNALING_URL');
            }
        },
        getDefaultSessionId: function () {
            try {
                const params = new URLSearchParams(window.location.search);
                const querySession = params.get('session') || params.get('sessionId');
                if (querySession) return querySession;
            } catch (e) {}
            return DEFAULT_CONFIG.DEFAULT_SESSION_ID;
        },
        getStunServers: function () {
            return DEFAULT_CONFIG.STUN_SERVERS;
        }
    };

    console.log('[Config] Active Signaling URL:', resolveSignalingUrl());
})();
