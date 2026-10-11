package com.example.womensafety.websocket;

import com.example.womensafety.model.PairingSession;
import com.example.womensafety.model.SignalingMessage;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.Map;
import java.util.Set;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Spring WebSocket Text Handler for WebRTC Signaling + Pairing Protocol.
 *
 * Authorization model:
 * - Dashboard creates a pairing session (CREATE_PAIRING_SESSION).
 * - Server issues pairingSessionId + dashboardAuthToken to dashboard only.
 * - Phone submits pairingCode via JOIN_PAIRING_SESSION.
 * - Server validates code, issues phoneAuthToken to phone.
 * - All subsequent messages (OFFER, ANSWER, ICE_CANDIDATE, etc.) must include
 *   authToken. Server validates before forwarding.
 * - Token is NEVER logged, stored in URLs, or exposed in QR codes.
 */
@Component
public class SignalingHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(SignalingHandler.class);

    private final SessionManager sessionManager;
    private final PairingManager pairingManager;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final Set<String> creatingPairingSessions = java.util.concurrent.ConcurrentHashMap.newKeySet();

    public SignalingHandler(SessionManager sessionManager, PairingManager pairingManager) {
        this.sessionManager = sessionManager;
        this.pairingManager = pairingManager;
    }

    private void notifyDashboardPairingRequested(PairingSession pairingSession, String phoneDeviceId) {
        SessionManager.ClientInfo dashboardInfo =
                sessionManager.getClientByWsId(pairingSession.getDashboardWsId());
        if (dashboardInfo == null || !dashboardInfo.getSession().isOpen()) {
            return;
        }
        SignalingMessage requested = new SignalingMessage();
        requested.setType("PAIRING_REQUESTED");
        requested.setRole("SERVER");
        requested.setPairingSessionId(pairingSession.getSessionId());
        requested.setPayload(Map.of("phoneDeviceId", phoneDeviceId));
        sessionManager.sendMessage(dashboardInfo.getSession(), requested);
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        session.setTextMessageSizeLimit(65536);
        session.setBinaryMessageSizeLimit(65536);
        log.info("[WebSocket] Connection established: wsId={}", session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        String payload = message.getPayload();
        try {
            SignalingMessage sigMsg = objectMapper.readValue(payload, SignalingMessage.class);
            if (sigMsg.getType() == null) {
                log.warn("[SignalingHandler] Received message without type from wsId={}", session.getId());
                return;
            }

            String type = sigMsg.getType().toUpperCase();

            // Log type but NOT authToken or pairingCode
            log.info("[SignalingHandler] Processing type={}, role={}, deviceId={}, wsId={}",
                    type, sigMsg.getRole(), sigMsg.getDeviceId(), session.getId());

            switch (type) {
                // ---- Pairing Protocol ----
                case "CREATE_PAIRING_SESSION":
                    if (!creatingPairingSessions.add(session.getId())) {
                        sendErrorMessage(session, "SESSION_EXISTS", "A pairing session is already active on this connection");
                    } else {
                        try {
                            handleCreatePairingSession(session, sigMsg);
                        } catch (RuntimeException e) {
                            creatingPairingSessions.remove(session.getId());
                            throw e;
                        }
                    }
                    break;

                case "JOIN_PAIRING_SESSION":
                    handleJoinPairingSession(session, sigMsg);
                    break;

                case "UNPAIR":
                    handleUnpair(session, sigMsg);
                    break;

                // ---- Legacy REGISTER (maps to pairing-aware registration) ----
                case "REGISTER":
                    handleRegister(session, sigMsg);
                    break;

                // ---- WebRTC Signaling (all require authorization) ----
                case "OFFER":
                    handleOffer(session, sigMsg);
                    break;

                case "ANSWER":
                    handleAnswer(session, sigMsg);
                    break;

                case "ICE_CANDIDATE":
                    handleIceCandidate(session, sigMsg);
                    break;

                case "REQUEST_OFFER":
                    handleRequestOffer(session, sigMsg);
                    break;

                case "STREAM_STARTED":
                    handleStreamStarted(session, sigMsg);
                    break;

                case "CAMERA_READY":
                    handleCameraReady(session, sigMsg);
                    break;

                case "STREAM_STOPPED":
                case "PEER_DISCONNECTED":
                    handleStreamStopped(session, sigMsg);
                    break;

                case "PING":
                    SignalingMessage pong = new SignalingMessage("PONG", sigMsg.getSessionId(),
                            sigMsg.getRole(), sigMsg.getDeviceId(), null);
                    sessionManager.sendMessage(session, pong);
                    break;

                default:
                    log.warn("[SignalingHandler] Unknown signaling message type: {}", type);
                    break;
            }

        } catch (Exception e) {
            log.error("[SignalingHandler] Error parsing/handling message from wsId={}, exception={}",
                    session.getId(), e.getClass().getSimpleName());
            sendErrorMessage(session, "SERVER_ERROR", "Invalid signaling message format");
        }
    }

    // =========================================================================
    // PAIRING HANDLERS
    // =========================================================================

    /**
     * Dashboard requests creation of a new pairing session.
     * Responds with pairingSessionId, pairingCode, expiresAt, dashboardAuthToken.
     * The authToken is ONLY sent to the dashboard and never in QR codes.
     */
    private void handleCreatePairingSession(WebSocketSession session, SignalingMessage msg) {
        if (!"DASHBOARD".equalsIgnoreCase(msg.getRole())) {
            sendErrorMessage(session, "UNAUTHORIZED", "Only a dashboard can create a pairing session");
            return;
        }
        // Create pairing session
        PairingSession pairingSession = pairingManager.createPairingSession(session.getId(), "dashboard");
        sessionManager.registerClient(session, "pairing-" + session.getId(), "DASHBOARD",
                pairingSession.getDashboardDeviceId());

        // Respond with session details (authToken stays server-side for dashboard token validation)
        SignalingMessage response = new SignalingMessage();
        response.setType("PAIRING_SESSION_CREATED");
        response.setRole("SERVER");
        response.setDeviceId("server");
        response.setPairingSessionId(pairingSession.getSessionId());
        response.setAuthToken(pairingSession.getDashboardAuthToken()); // Only to dashboard
        response.setPayload(Map.of(
                "pairingCode", pairingSession.getPairingCode(),
                "pairingSessionId", pairingSession.getSessionId(),
                "expiresAt", pairingSession.getExpiresAt().toString(),
                "secondsUntilExpiry", pairingSession.getSecondsUntilExpiry(),
                "phoneUrl", "https://major-project-frontend-blond.vercel.app/pages/phone.html",
                "status", "WAITING_FOR_PAIRING"
        ));
        response.setTimestamp(System.currentTimeMillis());

        sessionManager.sendMessage(session, response);
        log.info("[Pairing] PAIRING_SESSION_CREATED sent to dashboard wsId={}", session.getId());
    }

    /**
     * Phone submits a pairing code to join a session.
     * Validates code and issues phoneAuthToken on success.
     */
    private void handleJoinPairingSession(WebSocketSession session, SignalingMessage msg) {
        String code = msg.getPairingCode();
        String deviceId;
        if (!"PHONE".equalsIgnoreCase(msg.getRole())) {
            sendErrorMessage(session, "UNAUTHORIZED", "Only a phone can join a pairing session");
            return;
        }
        PairingSession targetSession = pairingManager.getSessionByPairingCode(code);
        if (targetSession != null) {
            SessionManager.ClientInfo dashboard =
                    sessionManager.getClientByWsId(targetSession.getDashboardWsId());
            if (dashboard == null || !dashboard.getSession().isOpen()) {
                sendErrorMessage(session, "DASHBOARD_DISCONNECTED", "Dashboard is no longer connected.");
                return;
            }
        }

        try {
            PairingSession pairingSession = pairingManager.attemptPairing(
                    code, session.getId(), null, getPairingRateLimitKey(session));
            deviceId = pairingSession.getPhoneDeviceId();

            pairingSession.setState(PairingSession.State.PAIRING_REQUESTED);
            notifyDashboardPairingRequested(pairingSession, deviceId);
            pairingSession.setState(PairingSession.State.PAIRED);

            // Register phone in session manager using the pairing session ID as the room
            sessionManager.registerClient(session, pairingSession.getSessionId(), "PHONE", deviceId);

            // Notify phone of successful pairing
            SignalingMessage phoneResponse = new SignalingMessage();
            phoneResponse.setType("PAIRING_APPROVED");
            phoneResponse.setRole("SERVER");
            phoneResponse.setDeviceId("server");
            phoneResponse.setPairingSessionId(pairingSession.getSessionId());
            phoneResponse.setAuthToken(pairingSession.getPhoneAuthToken()); // Only to phone
            phoneResponse.setPayload(Map.of(
                    "pairingSessionId", pairingSession.getSessionId(),
                    "dashboardDeviceId", pairingSession.getDashboardDeviceId(),
                    "phoneDeviceId", pairingSession.getPhoneDeviceId(),
                    "pairedAt", pairingSession.getPairedAt().toString(),
                    "status", "PAIRED"
            ));
            sessionManager.sendMessage(session, phoneResponse);

            // Notify dashboard that device is paired
            notifyDashboardDevicePaired(pairingSession, deviceId);

            log.info("[Pairing] Phone paired: deviceId={}, session={}", deviceId, pairingSession.getSessionId());

        } catch (PairingManager.PairingException e) {
            log.warn("[Pairing] Pairing failed for wsId={}: errorCode={}, reason={}", session.getId(), e.getErrorCode(), e.getMessage());
            SignalingMessage rejection = new SignalingMessage();
            rejection.setType("EXPIRED".equals(e.getErrorCode()) ? "PAIRING_EXPIRED" : "PAIRING_REJECTED");
            rejection.setRole("SERVER");
            rejection.setDeviceId("server");
            rejection.setPayload(Map.of(
                    "errorCode", e.getErrorCode(),
                    "reason", e.getMessage()
            ));
            sessionManager.sendMessage(session, rejection);
        }

    }

    private String getPairingRateLimitKey(WebSocketSession session) {
        if (session.getRemoteAddress() != null && session.getRemoteAddress().getAddress() != null) {
            String remoteAddress = session.getRemoteAddress().getAddress().getHostAddress();
            if (session.getRemoteAddress().getAddress().isLoopbackAddress()) {
                String forwardedAddress = session.getHandshakeHeaders().getFirst("CF-Connecting-IP");
                if (forwardedAddress != null && forwardedAddress.length() <= 45
                        && forwardedAddress.matches("[0-9a-fA-F:.]+")) {
                    return forwardedAddress;
                }
            }
            return remoteAddress;
        }
        return "connection-" + session.getId();
    }

    private void notifyDashboardDevicePaired(PairingSession pairingSession, String phoneDeviceId) {
        // Find the dashboard's WebSocket session
        String dashboardWsId = pairingSession.getDashboardWsId();
        if (dashboardWsId == null) return;

        // Get the actual WebSocket session for the dashboard
        SessionManager.ClientInfo dashboardInfo = sessionManager.getClientByWsId(dashboardWsId);
        if (dashboardInfo == null || !dashboardInfo.getSession().isOpen()) {
            log.warn("[Pairing] Dashboard session not found or closed: wsId={}", dashboardWsId);
            return;
        }

        SignalingMessage devicePaired = new SignalingMessage();
        devicePaired.setType("DEVICE_PAIRED");
        devicePaired.setRole("SERVER");
        devicePaired.setDeviceId("server");
        devicePaired.setPairingSessionId(pairingSession.getSessionId());
        devicePaired.setPayload(Map.of(
                "phoneDeviceId", phoneDeviceId,
                "pairingSessionId", pairingSession.getSessionId(),
                "pairedAt", pairingSession.getPairedAt().toString(),
                "status", "PAIRED"
        ));
        sessionManager.sendMessage(dashboardInfo.getSession(), devicePaired);
        log.info("[Pairing] DEVICE_PAIRED notification sent to dashboard wsId={}", dashboardWsId);
    }

    /**
     * Handle UNPAIR request from either dashboard or phone.
     * Immediately revokes phone's auth token.
     */
    private void handleUnpair(WebSocketSession session, SignalingMessage msg) {
        String authToken = msg.getAuthToken();
        PairingSession pairingSession = findAndValidateSession(session, authToken, msg.getPairingSessionId());
        if (pairingSession == null || !hasExpectedRole(session, pairingSession, msg.getRole())) {
            sendErrorMessage(session, "UNAUTHORIZED", "Not authorized to unpair this session");
            return;
        }

        String sessionId = pairingSession.getSessionId();
        String phoneWsId = pairingSession.getPhoneWsId();
        String dashboardWsId = pairingSession.getDashboardWsId();
        boolean requestedByPhone = session.getId().equals(phoneWsId);

        // Revoke authorization
        pairingManager.unpair(sessionId);

        // Notify phone it has been unpaired
        if (phoneWsId != null) {
            SessionManager.ClientInfo phoneInfo = sessionManager.getClientByWsId(phoneWsId);
            if (phoneInfo != null && phoneInfo.getSession().isOpen()) {
                SignalingMessage unpairMsg = new SignalingMessage();
                unpairMsg.setType("DEVICE_UNPAIRED");
                unpairMsg.setRole("SERVER");
                unpairMsg.setDeviceId("server");
                unpairMsg.setPayload(Map.of("reason", requestedByPhone
                        ? "Phone disconnected" : "Unpaired by dashboard"));
                sessionManager.sendMessage(phoneInfo.getSession(), unpairMsg);
            }
        }

        // Notify dashboard
        if (dashboardWsId != null) {
            SessionManager.ClientInfo dashboardInfo = sessionManager.getClientByWsId(dashboardWsId);
            if (dashboardInfo != null && dashboardInfo.getSession().isOpen()) {
                SignalingMessage unpairMsg = new SignalingMessage();
                unpairMsg.setType("DEVICE_UNPAIRED");
                unpairMsg.setRole("SERVER");
                unpairMsg.setDeviceId("server");
                unpairMsg.setPayload(Map.of("reason", "Device unpaired", "status", "UNPAIRED"));
                sessionManager.sendMessage(dashboardInfo.getSession(), unpairMsg);
            }
        }

        log.info("[Pairing] UNPAIR completed for session={}", sessionId);
    }

    // =========================================================================
    // Legacy clients are not permitted to register or exchange signaling without pairing.
    // =========================================================================

    private void handleRegister(WebSocketSession session, SignalingMessage msg) {
        log.warn("[Auth] Rejected legacy REGISTER from wsId={}", session.getId());
        sendErrorMessage(session, "PAIRING_REQUIRED",
                "Create a pairing session or join one with a valid pairing code before signaling");
    }

    // =========================================================================
    // WEBRTC SIGNALING HANDLERS (all require authorization)
    // =========================================================================

    private void handleOffer(WebSocketSession session, SignalingMessage msg) {
        PairingSession pairingSession = authorizeSignalingMessage(session, msg, "PHONE");
        if (pairingSession == null) return;
        if (pairingSession.getState() != PairingSession.State.CAMERA_READY
                && pairingSession.getState() != PairingSession.State.STREAMING) {
            sendErrorMessage(session, "INVALID_STATE", "Camera must be ready before sending an offer");
            return;
        }

        log.info("[WebSocket] Forwarding authorized OFFER from phone={} to dashboard in session={}",
                msg.getDeviceId(), pairingSession.getSessionId());

        // Forward only to the paired dashboard
        String dashboardWsId = pairingSession.getDashboardWsId();
        if (dashboardWsId != null) {
            SessionManager.ClientInfo dashboardInfo = sessionManager.getClientByWsId(dashboardWsId);
            if (dashboardInfo != null && dashboardInfo.getSession().isOpen()) {
                // Strip auth token before forwarding
                msg.setAuthToken(null);
                sessionManager.sendMessage(dashboardInfo.getSession(), msg);
                return;
            }
        }
        log.warn("[WebSocket] OFFER: paired dashboard not available for session={}", pairingSession.getSessionId());
        sendErrorMessage(session, "PEER_UNAVAILABLE", "Dashboard is not connected");
    }

    private void handleAnswer(WebSocketSession session, SignalingMessage msg) {
        PairingSession pairingSession = authorizeSignalingMessage(session, msg, "DASHBOARD");
        if (pairingSession == null) return;
        if (pairingSession.getState() != PairingSession.State.CAMERA_READY
                && pairingSession.getState() != PairingSession.State.STREAMING) {
            sendErrorMessage(session, "INVALID_STATE", "Phone camera is not ready for an answer");
            return;
        }

        log.info("[WebSocket] Forwarding authorized ANSWER from dashboard to phone in session={}",
                pairingSession.getSessionId());

        // Forward only to the paired phone
        String phoneWsId = pairingSession.getPhoneWsId();
        if (phoneWsId != null) {
            SessionManager.ClientInfo phoneInfo = sessionManager.getClientByWsId(phoneWsId);
            if (phoneInfo != null && phoneInfo.getSession().isOpen()) {
                msg.setAuthToken(null);
                sessionManager.sendMessage(phoneInfo.getSession(), msg);
                return;
            }
        }
        log.warn("[WebSocket] ANSWER: paired phone not available for session={}", pairingSession.getSessionId());
        sendErrorMessage(session, "PEER_UNAVAILABLE", "Phone is not connected");
    }

    private void handleIceCandidate(WebSocketSession session, SignalingMessage msg) {
        PairingSession associatedSession = pairingManager.getAuthorizedSession(session.getId());
        String expectedRole = associatedSession == null ? ""
                : session.getId().equals(associatedSession.getPhoneWsId()) ? "PHONE"
                : session.getId().equals(associatedSession.getDashboardWsId()) ? "DASHBOARD" : "";
        PairingSession pairingSession = authorizeSignalingMessage(session, msg, expectedRole);
        if (pairingSession == null
                || (pairingSession.getState() != PairingSession.State.CAMERA_READY
                && pairingSession.getState() != PairingSession.State.STREAMING)) {
            log.warn("[WebSocket] Unauthorized ICE_CANDIDATE from wsId={}", session.getId());
            if (pairingSession != null) {
                sendErrorMessage(session, "INVALID_STATE", "Camera is not ready for ICE exchange");
            }
            return;
        }

        boolean isPhone = session.getId().equals(pairingSession.getPhoneWsId());
        boolean isDashboard = session.getId().equals(pairingSession.getDashboardWsId());

        msg.setAuthToken(null); // Strip before forwarding
        if (isPhone) {
            // Phone sends ICE -> dashboard
            String dashboardWsId = pairingSession.getDashboardWsId();
            if (dashboardWsId != null) {
                SessionManager.ClientInfo dashboardInfo = sessionManager.getClientByWsId(dashboardWsId);
                if (dashboardInfo != null && dashboardInfo.getSession().isOpen()) {
                    sessionManager.sendMessage(dashboardInfo.getSession(), msg);
                    log.debug("[ICE] Phone->Dashboard candidate forwarded in session={}", pairingSession.getSessionId());
                }
            }
        } else if (isDashboard) {
            // Dashboard sends ICE -> phone
            String phoneWsId = pairingSession.getPhoneWsId();
            if (phoneWsId != null) {
                SessionManager.ClientInfo phoneInfo = sessionManager.getClientByWsId(phoneWsId);
                if (phoneInfo != null && phoneInfo.getSession().isOpen()) {
                    sessionManager.sendMessage(phoneInfo.getSession(), msg);
                    log.debug("[ICE] Dashboard->Phone candidate forwarded in session={}", pairingSession.getSessionId());
                }
            }
        } else {
            sendErrorMessage(session, "UNAUTHORIZED", "Only paired devices can exchange ICE candidates");
        }
    }

    private void handleRequestOffer(WebSocketSession session, SignalingMessage msg) {
        PairingSession pairingSession = authorizeSignalingMessage(session, msg, "DASHBOARD");
        if (pairingSession == null) return;
        if (pairingSession.getState() != PairingSession.State.CAMERA_READY
                && pairingSession.getState() != PairingSession.State.STREAMING) {
            sendErrorMessage(session, "INVALID_STATE", "The paired phone camera is not ready");
            return;
        }

        String phoneWsId = pairingSession.getPhoneWsId();
        if (phoneWsId != null) {
            SessionManager.ClientInfo phoneInfo = sessionManager.getClientByWsId(phoneWsId);
            if (phoneInfo != null && phoneInfo.getSession().isOpen()) {
                msg.setAuthToken(null);
                sessionManager.sendMessage(phoneInfo.getSession(), msg);
                log.info("[WebSocket] REQUEST_OFFER forwarded to phone in session={}", pairingSession.getSessionId());
            }
        }
    }

    private void handleStreamStarted(WebSocketSession session, SignalingMessage msg) {
        PairingSession pairingSession = authorizeSignalingMessage(session, msg, "DASHBOARD");
        if (pairingSession == null) return;

        if (pairingSession.getState() != PairingSession.State.CAMERA_READY) {
            sendErrorMessage(session, "INVALID_STATE", "A paired camera must be ready before streaming starts");
            return;
        }
        pairingSession.setState(PairingSession.State.STREAMING);
        log.info("[Pairing] State -> STREAMING for session={}", pairingSession.getSessionId());

        // The dashboard reports STREAMING only after its WebRTC receiver gets the remote video track.
        String phoneWsId = pairingSession.getPhoneWsId();
        SessionManager.ClientInfo phoneInfo = sessionManager.getClientByWsId(phoneWsId);
        if (phoneInfo != null && phoneInfo.getSession().isOpen()) {
            msg.setAuthToken(null);
            msg.setRole("SERVER");
            sessionManager.sendMessage(phoneInfo.getSession(), msg);
        }
    }

    private void handleCameraReady(WebSocketSession session, SignalingMessage msg) {
        PairingSession pairingSession = authorizeSignalingMessage(session, msg, "PHONE");
        if (pairingSession == null) return;
        if (pairingSession.getState() != PairingSession.State.PAIRED) {
            sendErrorMessage(session, "INVALID_STATE", "Camera readiness can only be set after pairing");
            return;
        }

        pairingSession.setState(PairingSession.State.CAMERA_READY);
        String dashboardWsId = pairingSession.getDashboardWsId();
        SessionManager.ClientInfo dashboardInfo = sessionManager.getClientByWsId(dashboardWsId);
        if (dashboardInfo != null && dashboardInfo.getSession().isOpen()) {
            SignalingMessage ready = new SignalingMessage();
            ready.setType("CAMERA_READY");
            ready.setRole("SERVER");
            ready.setPairingSessionId(pairingSession.getSessionId());
            ready.setDeviceId(pairingSession.getPhoneDeviceId());
            ready.setPayload(msg.getPayload());
            sessionManager.sendMessage(dashboardInfo.getSession(), ready);
        }
        SessionManager.ClientInfo phoneInfo = sessionManager.getClientByWsId(session.getId());
        if (phoneInfo != null && phoneInfo.getSession().isOpen()) {
            SignalingMessage ready = new SignalingMessage();
            ready.setType("CAMERA_READY");
            ready.setRole("SERVER");
            ready.setPairingSessionId(pairingSession.getSessionId());
            ready.setPayload(msg.getPayload());
            sessionManager.sendMessage(phoneInfo.getSession(), ready);
        }
        log.info("[Pairing] State -> CAMERA_READY for session={}", pairingSession.getSessionId());
    }

    private void handleStreamStopped(WebSocketSession session, SignalingMessage msg) {
        PairingSession pairingSession = findAndValidateSession(session, msg.getAuthToken(), msg.getPairingSessionId());

        if (pairingSession != null && isParticipant(session, pairingSession)
                && hasExpectedRole(session, pairingSession, msg.getRole())
                && (pairingSession.getState() == PairingSession.State.CAMERA_READY
                || pairingSession.getState() == PairingSession.State.STREAMING)) {
            pairingSession.setState(PairingSession.State.PAIRED); // Back to paired but not streaming
            log.info("[Pairing] State -> PAIRED (stream stopped) for session={}", pairingSession.getSessionId());

            String recipientWsId = session.getId().equals(pairingSession.getPhoneWsId())
                    ? pairingSession.getDashboardWsId() : pairingSession.getPhoneWsId();
            SessionManager.ClientInfo recipient = sessionManager.getClientByWsId(recipientWsId);
            if (recipient != null && recipient.getSession().isOpen()) {
                msg.setAuthToken(null);
                msg.setRole("SERVER");
                sessionManager.sendMessage(recipient.getSession(), msg);
            }
        } else {
            sendErrorMessage(session, "UNAUTHORIZED", "Only paired devices can stop streaming");
        }
    }

    // =========================================================================
    // CONNECTION LIFECYCLE
    // =========================================================================

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.error("[WebSocket] Transport error on wsId={}: {}", session.getId(), exception.getMessage());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        log.info("[WebSocket] Connection closed: wsId={}, code={}", session.getId(), status.getCode());

        // Handle pairing session cleanup
        PairingSession affectedPairing = pairingManager.handleDisconnect(session.getId());
        creatingPairingSessions.remove(session.getId());
        if (affectedPairing != null) {
            log.info("[Pairing] Disconnect handled for session={}, state={}",
                    affectedPairing.getSessionId(), affectedPairing.getState());

            // If phone disconnected, notify dashboard
            if (affectedPairing.getState() == PairingSession.State.DISCONNECTED) {
                String dashboardWsId = affectedPairing.getDashboardWsId();
                if (dashboardWsId != null) {
                    SessionManager.ClientInfo dashboardInfo = sessionManager.getClientByWsId(dashboardWsId);
                    if (dashboardInfo != null && dashboardInfo.getSession().isOpen()) {
                        SignalingMessage disconnectMsg = new SignalingMessage();
                        disconnectMsg.setType("DEVICE_DISCONNECTED");
                        disconnectMsg.setRole("SERVER");
                        disconnectMsg.setDeviceId("server");
                        disconnectMsg.setPairingSessionId(affectedPairing.getSessionId());
                        disconnectMsg.setPayload(Map.of(
                                "reason", "Phone disconnected",
                                "phoneDeviceId", affectedPairing.getPhoneDeviceId() != null
                                        ? affectedPairing.getPhoneDeviceId() : "unknown",
                                "status", "DISCONNECTED"
                        ));
                        sessionManager.sendMessage(dashboardInfo.getSession(), disconnectMsg);
                    }
                }
            } else if (affectedPairing.getState() == PairingSession.State.UNPAIRED
                    && affectedPairing.getPhoneWsId() != null) {
                SessionManager.ClientInfo phoneInfo =
                        sessionManager.getClientByWsId(affectedPairing.getPhoneWsId());
                if (phoneInfo != null && phoneInfo.getSession().isOpen()) {
                    SignalingMessage disconnected = new SignalingMessage();
                    disconnected.setType("DEVICE_UNPAIRED");
                    disconnected.setRole("SERVER");
                    disconnected.setPayload(Map.of("reason", "Dashboard disconnected"));
                    sessionManager.sendMessage(phoneInfo.getSession(), disconnected);
                }
            }
        }

        // Remove from session manager
        SessionManager.ClientInfo removed = sessionManager.removeSession(session);
        if (removed != null) {
            log.info("[WebSocket] Removed from session manager: role={}, deviceId={}",
                    removed.getRole(), removed.getDeviceId());
        }
    }

    // =========================================================================
    // AUTHORIZATION HELPERS
    // =========================================================================

    /**
     * Finds and validates a pairing session for a message.
     * Accepts either a dashboard or phone auth token.
     */
    private PairingSession findAndValidateSession(WebSocketSession session, String authToken, String pairingSessionId) {
        PairingSession ps = pairingManager.getAuthorizedSession(session.getId());
        if (ps == null || !ps.isActive() || authToken == null || authToken.isBlank()
                || pairingSessionId == null || !pairingSessionId.equals(ps.getSessionId())) {
            return null;
        }
        boolean validDashboard = session.getId().equals(ps.getDashboardWsId())
                && tokensMatch(authToken, ps.getDashboardAuthToken());
        boolean validPhone = session.getId().equals(ps.getPhoneWsId())
                && tokensMatch(authToken, ps.getPhoneAuthToken());
        return validDashboard || validPhone ? ps : null;
    }

    private boolean tokensMatch(String provided, String expected) {
        return expected != null && MessageDigest.isEqual(
                provided.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8));
    }

    private boolean isParticipant(WebSocketSession session, PairingSession pairingSession) {
        return session.getId().equals(pairingSession.getDashboardWsId())
                || session.getId().equals(pairingSession.getPhoneWsId());
    }

    private boolean hasExpectedRole(WebSocketSession session, PairingSession pairingSession, String role) {
        return (session.getId().equals(pairingSession.getPhoneWsId()) && "PHONE".equalsIgnoreCase(role))
                || (session.getId().equals(pairingSession.getDashboardWsId()) && "DASHBOARD".equalsIgnoreCase(role));
    }

    /**
     * Authorize a signaling message for a specific role.
     * Logs and sends error on failure.
     */
    private PairingSession authorizeSignalingMessage(WebSocketSession session, SignalingMessage msg, String expectedRole) {
        PairingSession ps = findAndValidateSession(session, msg.getAuthToken(), msg.getPairingSessionId());
        if (ps == null) {
            log.warn("[Auth] Unauthorized {} from wsId={} - no valid pairing session", msg.getType(), session.getId());
            sendErrorMessage(session, "UNAUTHORIZED",
                    "Not authorized. You must pair with a dashboard first.");
            return null;
        }
        if (!expectedRole.equalsIgnoreCase(msg.getRole())) {
            sendErrorMessage(session, "UNAUTHORIZED", "Role does not match this WebSocket connection");
            return null;
        }

        if (!ps.isPaired()) {
            log.warn("[Auth] {} rejected - session {} is not in paired state (state={})",
                    msg.getType(), ps.getSessionId(), ps.getState());
            sendErrorMessage(session, "NOT_PAIRED", "Pairing session is not active");
            return null;
        }

        // Role check
        if ("PHONE".equals(expectedRole) && !session.getId().equals(ps.getPhoneWsId())) {
            log.warn("[Auth] {} rejected - sender is not the authorized phone for session={}", msg.getType(), ps.getSessionId());
            sendErrorMessage(session, "UNAUTHORIZED", "Only the paired phone can send " + msg.getType());
            return null;
        }
        if ("DASHBOARD".equals(expectedRole) && !session.getId().equals(ps.getDashboardWsId())) {
            log.warn("[Auth] {} rejected - sender is not the authorized dashboard for session={}", msg.getType(), ps.getSessionId());
            sendErrorMessage(session, "UNAUTHORIZED", "Only the paired dashboard can send " + msg.getType());
            return null;
        }

        return ps;
    }

    private void sendErrorMessage(WebSocketSession session, String errorCode, String errorMsg) {
        SignalingMessage error = new SignalingMessage();
        error.setType("ERROR");
        error.setRole("SERVER");
        error.setDeviceId("server");
        error.setPayload(Map.of("errorCode", errorCode, "error", errorMsg));
        sessionManager.sendMessage(session, error);
    }
}
