package com.example.womensafety.websocket;

import com.example.womensafety.model.PairingSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PairingManager: manages all pairing sessions lifecycle.
 *
 * Security design:
 * - Pairing codes: 6-char alphanumeric (uppercase), generated with SecureRandom.
 *   Format: "ABC-123" for readability. Entropy: ~30 bits - sufficient for 2-minute codes.
 * - Auth tokens: 256-bit hex strings from SecureRandom - used to authenticate
 *   all subsequent signaling after pairing.
 * - Codes expire after 2 minutes.
 * - Codes are single-use (consumed on successful pairing).
 * - Rate limiting: attempts are throttled per connection and failed attempts per source.
 * - Sessions are cleaned up after expiry or unpairing.
 * - Auth tokens are NEVER exposed in QR codes, URLs, or logs.
 */
@Component
public class PairingManager {

    private static final Logger log = LoggerFactory.getLogger(PairingManager.class);

    private static final SecureRandom SECURE_RANDOM = new SecureRandom();
    private static final String CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0,O,1,I to avoid confusion
    private static final int CODE_LENGTH = 6; // "ABC123" -> formatted as "ABC-123"
    private static final long CODE_VALIDITY_SECONDS = 120; // 2 minutes

    // Index: sessionId -> PairingSession
    private final Map<String, PairingSession> sessionsBySessionId = new ConcurrentHashMap<>();

    // Index: pairingCode -> sessionId (for quick lookup; normalized to uppercase)
    private final Map<String, String> codeToSessionId = new ConcurrentHashMap<>();

    // Index: dashboardAuthToken -> sessionId
    private final Map<String, String> dashboardTokenToSessionId = new ConcurrentHashMap<>();

    // Index: phoneAuthToken -> sessionId
    private final Map<String, String> phoneTokenToSessionId = new ConcurrentHashMap<>();

    // Index: WebSocket session ID -> pairing session ID
    private final Map<String, String> wsIdToPairingSessionId = new ConcurrentHashMap<>();
    private final Map<String, AttemptWindow> attemptsByConnection = new ConcurrentHashMap<>();
    private final Map<String, AttemptWindow> failedAttemptsBySource = new ConcurrentHashMap<>();

    private static final int MAX_ATTEMPTS_PER_CONNECTION = 10;
    private static final long ATTEMPT_WINDOW_MILLIS = 120_000;
    private static final int MAX_FAILED_ATTEMPTS_PER_SOURCE = 10;

    // -------------------------------------------------------------------------
    // Session creation (called by dashboard)
    // -------------------------------------------------------------------------

    /**
     * Create a new pairing session. Called when the dashboard opens and requests pairing.
     * Returns the created PairingSession (caller should send code/token to dashboard only).
     */
    public synchronized PairingSession createPairingSession(String dashboardWsId, String ignoredClientDeviceId) {
        String previousSessionId = wsIdToPairingSessionId.get(dashboardWsId);
        if (previousSessionId != null) {
            cleanupSession(previousSessionId);
        }

        // Generate cryptographically secure session ID
        String sessionId = generateSecureToken(16); // 128-bit

        // Generate human-readable pairing code
        String formattedCode;
        do {
            String rawCode = generateCode(CODE_LENGTH);
            formattedCode = rawCode.substring(0, 3) + "-" + rawCode.substring(3);
        } while (codeToSessionId.containsKey(formattedCode));

        // Code expires in 2 minutes
        Instant expiresAt = Instant.now().plusSeconds(CODE_VALIDITY_SECONDS);

        // Generate dashboard auth token (never in QR/URL)
        String dashboardAuthToken = generateSecureToken(32); // 256-bit

        String dashboardDeviceId = "dashboard-" + generateSecureToken(6);
        PairingSession session = new PairingSession(sessionId, formattedCode, expiresAt, dashboardAuthToken);
        session.setDashboardWsId(dashboardWsId);
        session.setDashboardDeviceId(dashboardDeviceId);

        // Store indices
        sessionsBySessionId.put(sessionId, session);
        codeToSessionId.put(formattedCode.toUpperCase(), sessionId);
        dashboardTokenToSessionId.put(dashboardAuthToken, sessionId);
        wsIdToPairingSessionId.put(dashboardWsId, sessionId);

        log.info("[Pairing] Created pairing session={}, expiresAt={}, dashboard={}",
                sessionId, expiresAt, dashboardDeviceId);
        // Do NOT log the pairing code or auth token

        return session;
    }

    // -------------------------------------------------------------------------
    // Pairing attempt (called by phone)
    // -------------------------------------------------------------------------

    /**
     * Attempt to pair a phone using a pairing code.
     *
     * @param code            the code entered by the phone (case-insensitive)
     * @param phoneWsId       the phone's WebSocket session ID
     * @param phoneDeviceId   the phone's self-reported device ID
     * @return the PairingSession if successful, null if failed
     * @throws PairingException on specific failure reason
     */
    public synchronized PairingSession attemptPairing(
            String code, String phoneWsId, String ignoredClientDeviceId, String sourceKey)
            throws PairingException {
        String rateLimitKey = sourceKey != null ? sourceKey : phoneWsId;
        if (isConnectionRateLimited(phoneWsId) || isSourceRateLimited(rateLimitKey)) {
            throw new PairingException("RATE_LIMITED", "Too many pairing attempts. Wait before trying again.");
        }

        if (code == null || code.isBlank()) {
            recordSourceFailure(rateLimitKey);
            throw new PairingException("INVALID_CODE", "Pairing code is required");
        }

        String normalizedCode = code.trim().toUpperCase();

        // Find session by code
        String sessionId = codeToSessionId.get(normalizedCode);
        if (sessionId == null) {
            log.warn("[Pairing] Phone attempted with unknown code (wsId={})", phoneWsId);
            recordSourceFailure(rateLimitKey);
            throw new PairingException("INVALID_CODE", "Invalid pairing code");
        }

        PairingSession session = sessionsBySessionId.get(sessionId);
        if (session == null) {
            recordSourceFailure(rateLimitKey);
            throw new PairingException("INVALID_CODE", "Pairing session not found");
        }

        // Rate limiting check
        if (session.isRateLimited()) {
            log.warn("[Pairing] Rate limit exceeded for session={}", sessionId);
            throw new PairingException("RATE_LIMITED", "Too many failed attempts. Generate a new pairing code.");
        }

        // Expiry check
        if (session.isExpired()) {
            session.setState(PairingSession.State.EXPIRED);
            recordSourceFailure(rateLimitKey);
            log.warn("[Pairing] Phone attempted with expired code, session={}", sessionId);
            throw new PairingException("EXPIRED", "Pairing code has expired. Please generate a new code.");
        }

        // Single-use check
        if (session.isCodeConsumed()) {
            session.incrementFailedAttempts();
            recordSourceFailure(rateLimitKey);
            log.warn("[Pairing] Phone attempted to reuse consumed code, session={}", sessionId);
            throw new PairingException("CODE_CONSUMED", "Pairing code has already been used.");
        }

        // State check
        if (session.getState() != PairingSession.State.WAITING_FOR_PAIRING) {
            session.incrementFailedAttempts();
            recordSourceFailure(rateLimitKey);
            log.warn("[Pairing] Session is not in WAITING_FOR_PAIRING state: {}", session.getState());
            throw new PairingException("SESSION_BUSY", "This pairing session is no longer available.");
        }

        // Dashboard still connected?
        if (session.getDashboardWsId() == null) {
            recordSourceFailure(sourceKey);
            throw new PairingException("DASHBOARD_DISCONNECTED", "Dashboard is no longer connected.");
        }

        // SUCCESS: consume code, assign phone, generate phone auth token
        session.consumeCode();
        session.setPhoneWsId(phoneWsId);
        String phoneDeviceId = "phone-" + generateSecureToken(6);
        session.setPhoneDeviceId(phoneDeviceId);
        session.setState(PairingSession.State.PAIRED);
        session.setPairedAt(Instant.now());

        String phoneAuthToken = generateSecureToken(32); // 256-bit
        session.setPhoneAuthToken(phoneAuthToken);

        // Store reverse indices
        phoneTokenToSessionId.put(phoneAuthToken, sessionId);
        wsIdToPairingSessionId.put(phoneWsId, sessionId);

        log.info("[Pairing] SUCCESS: session={}, phone={}, dashboard={}",
                sessionId, phoneDeviceId, session.getDashboardDeviceId());

        return session;
    }

    private boolean isConnectionRateLimited(String wsId) {
        long now = System.currentTimeMillis();
        AttemptWindow window = attemptsByConnection.compute(wsId, (key, current) -> {
            if (current == null || now - current.startedAt >= ATTEMPT_WINDOW_MILLIS) {
                return new AttemptWindow(now, 1);
            }
            current.attempts++;
            return current;
        });
        return window.attempts > MAX_ATTEMPTS_PER_CONNECTION;
    }

    private boolean isSourceRateLimited(String sourceKey) {
        AttemptWindow window = failedAttemptsBySource.get(sourceKey);
        if (window == null || System.currentTimeMillis() - window.startedAt >= ATTEMPT_WINDOW_MILLIS) {
            return false;
        }
        return window.attempts >= MAX_FAILED_ATTEMPTS_PER_SOURCE;
    }

    private void recordSourceFailure(String sourceKey) {
        long now = System.currentTimeMillis();
        failedAttemptsBySource.compute(sourceKey, (key, current) -> {
            if (current == null || now - current.startedAt >= ATTEMPT_WINDOW_MILLIS) {
                return new AttemptWindow(now, 1);
            }
            current.attempts++;
            return current;
        });
    }

    // -------------------------------------------------------------------------
    // Authorization
    // -------------------------------------------------------------------------

    /**
     * Validate that a WebSocket session ID is authorized for the given pairing session.
     * Returns the PairingSession if authorized.
     */
    public PairingSession getAuthorizedSession(String wsId) {
        String sessionId = wsIdToPairingSessionId.get(wsId);
        if (sessionId == null) return null;
        return sessionsBySessionId.get(sessionId);
    }

    /**
     * Validate a dashboard auth token.
     */
    public PairingSession validateDashboardToken(String token) {
        if (token == null) return null;
        String sessionId = dashboardTokenToSessionId.get(token);
        if (sessionId == null) return null;
        return sessionsBySessionId.get(sessionId);
    }

    /**
     * Validate a phone auth token.
     */
    public PairingSession validatePhoneToken(String token) {
        if (token == null) return null;
        String sessionId = phoneTokenToSessionId.get(token);
        if (sessionId == null) return null;
        return sessionsBySessionId.get(sessionId);
    }

    /**
     * Check if a WebSocket session (by wsId) is the authorized phone for a pairing session.
     */
    public boolean isAuthorizedPhone(String wsId, String pairingSessionId) {
        PairingSession session = sessionsBySessionId.get(pairingSessionId);
        return session != null && wsId.equals(session.getPhoneWsId()) && session.isPaired();
    }

    /**
     * Check if a WebSocket session (by wsId) is the authorized dashboard for a pairing session.
     */
    public boolean isAuthorizedDashboard(String wsId, String pairingSessionId) {
        PairingSession session = sessionsBySessionId.get(pairingSessionId);
        return session != null && wsId.equals(session.getDashboardWsId());
    }

    // -------------------------------------------------------------------------
    // Unpairing and cleanup
    // -------------------------------------------------------------------------

    /**
     * Unpair a session - revoke phone's authorization immediately.
     */
    public synchronized PairingSession unpair(String pairingSessionId) {
        PairingSession session = sessionsBySessionId.get(pairingSessionId);
        if (session == null) return null;

        // Revoke phone token immediately
        if (session.getPhoneAuthToken() != null) {
            phoneTokenToSessionId.remove(session.getPhoneAuthToken());
            session.setPhoneAuthToken(null);
        }

        // Remove phone WebSocket mapping
        if (session.getPhoneWsId() != null) {
            wsIdToPairingSessionId.remove(session.getPhoneWsId());
            session.setPhoneWsId(null);
        }

        session.setState(PairingSession.State.UNPAIRED);
        log.info("[Pairing] Session unpaired: {}", pairingSessionId);
        return session;
    }

    /**
     * Called when a WebSocket connection closes - handle cleanup.
     * Returns the affected PairingSession (if any).
     */
    public synchronized PairingSession handleDisconnect(String wsId) {
        attemptsByConnection.remove(wsId);
        String sessionId = wsIdToPairingSessionId.remove(wsId);
        if (sessionId == null) return null;

        PairingSession session = sessionsBySessionId.get(sessionId);
        if (session == null) return null;

        boolean isPhone = wsId.equals(session.getPhoneWsId());
        boolean isDashboard = wsId.equals(session.getDashboardWsId());

        if (isPhone) {
            // Revoke phone auth token
            if (session.getPhoneAuthToken() != null) {
                phoneTokenToSessionId.remove(session.getPhoneAuthToken());
                session.setPhoneAuthToken(null);
            }
            session.setPhoneWsId(null);
            session.setState(PairingSession.State.DISCONNECTED);
            log.info("[Pairing] Phone disconnected from session={}", sessionId);
        } else if (isDashboard) {
            // Dashboard disconnected - invalidate the whole session
            session.setDashboardWsId(null);
            // Also revoke phone token so phone can't keep signaling
            if (session.getPhoneAuthToken() != null) {
                phoneTokenToSessionId.remove(session.getPhoneAuthToken());
                session.setPhoneAuthToken(null);
            }
            dashboardTokenToSessionId.remove(session.getDashboardAuthToken());
            if (session.getPhoneWsId() != null) {
                wsIdToPairingSessionId.remove(session.getPhoneWsId());
            }
            session.setState(PairingSession.State.UNPAIRED);
            // Remove session entirely
            cleanupSession(sessionId);
            log.info("[Pairing] Dashboard disconnected - session destroyed: {}", sessionId);
        }

        return session;
    }

    /**
     * Get a pairing session by its server-side session ID.
     */
    public PairingSession getSession(String sessionId) {
        return sessionsBySessionId.get(sessionId);
    }

    /**
     * Get all active pairing sessions (for diagnostics).
     */
    public Collection<PairingSession> getAllSessions() {
        return Collections.unmodifiableCollection(sessionsBySessionId.values());
    }

    /**
     * Get session by dashboard WsId.
     */
    public PairingSession getSessionByDashboardWsId(String dashboardWsId) {
        String sessionId = wsIdToPairingSessionId.get(dashboardWsId);
        if (sessionId == null) return null;
        return sessionsBySessionId.get(sessionId);
    }

    public PairingSession getSessionByPairingCode(String code) {
        if (code == null) return null;
        String sessionId = codeToSessionId.get(code.trim().toUpperCase());
        return sessionId == null ? null : sessionsBySessionId.get(sessionId);
    }

    // -------------------------------------------------------------------------
    // Scheduled cleanup of expired sessions
    // -------------------------------------------------------------------------

    @Scheduled(fixedDelay = 60000) // Run every 60 seconds
    public void cleanupExpiredSessions() {
        long now = System.currentTimeMillis();
        failedAttemptsBySource.forEach((key, window) -> {
            if (now - window.startedAt >= ATTEMPT_WINDOW_MILLIS) {
                failedAttemptsBySource.remove(key, window);
            }
        });
        List<String> toRemove = new ArrayList<>();
        for (Map.Entry<String, PairingSession> entry : sessionsBySessionId.entrySet()) {
            PairingSession session = entry.getValue();
            // Remove expired sessions that were never paired, and sessions that are unpaired/expired
            if ((session.isExpired() && session.getState() == PairingSession.State.WAITING_FOR_PAIRING)
                    || session.getState() == PairingSession.State.EXPIRED
                    || session.getState() == PairingSession.State.DISCONNECTED
                    || session.getState() == PairingSession.State.UNPAIRED) {
                toRemove.add(entry.getKey());
            }
        }
        for (String sessionId : toRemove) {
            cleanupSession(sessionId);
            log.info("[Pairing] Cleaned up expired/unpaired session: {}", sessionId);
        }
    }

    private void cleanupSession(String sessionId) {
        PairingSession session = sessionsBySessionId.remove(sessionId);
        if (session != null) {
            codeToSessionId.remove(session.getPairingCode().toUpperCase());
            if (session.getDashboardAuthToken() != null) {
                dashboardTokenToSessionId.remove(session.getDashboardAuthToken());
            }
            if (session.getPhoneAuthToken() != null) {
                phoneTokenToSessionId.remove(session.getPhoneAuthToken());
            }
            if (session.getDashboardWsId() != null) {
                wsIdToPairingSessionId.remove(session.getDashboardWsId());
            }
            if (session.getPhoneWsId() != null) {
                wsIdToPairingSessionId.remove(session.getPhoneWsId());
            }
        }
    }

    private static final class AttemptWindow {
        private final long startedAt;
        private int attempts;

        private AttemptWindow(long startedAt, int attempts) {
            this.startedAt = startedAt;
            this.attempts = attempts;
        }
    }

    // -------------------------------------------------------------------------
    // Cryptographic helpers
    // -------------------------------------------------------------------------

    private String generateCode(int length) {
        StringBuilder sb = new StringBuilder(length);
        for (int i = 0; i < length; i++) {
            sb.append(CODE_CHARS.charAt(SECURE_RANDOM.nextInt(CODE_CHARS.length())));
        }
        return sb.toString();
    }

    private String generateSecureToken(int bytes) {
        byte[] raw = new byte[bytes];
        SECURE_RANDOM.nextBytes(raw);
        StringBuilder hex = new StringBuilder(bytes * 2);
        for (byte b : raw) {
            hex.append(String.format("%02x", b));
        }
        return hex.toString();
    }

    // -------------------------------------------------------------------------
    // Exception type for pairing failures
    // -------------------------------------------------------------------------

    public static class PairingException extends Exception {
        private final String errorCode;

        public PairingException(String errorCode, String message) {
            super(message);
            this.errorCode = errorCode;
        }

        public String getErrorCode() {
            return errorCode;
        }
    }
}
