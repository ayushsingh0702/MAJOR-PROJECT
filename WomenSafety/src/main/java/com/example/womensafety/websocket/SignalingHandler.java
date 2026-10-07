package com.example.womensafety.websocket;

import com.example.womensafety.model.SignalingMessage;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.List;
import java.util.Map;

/**
 * Spring WebSocket Text Handler for WebRTC Signaling.
 * Exchanges SDP Offers, SDP Answers, ICE candidates, and peer lifecycle events.
 * High-performance, low-latency: No media data is routed through this handler.
 */
@Component
public class SignalingHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(SignalingHandler.class);

    private final SessionManager sessionManager;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public SignalingHandler(SessionManager sessionManager) {
        this.sessionManager = sessionManager;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        // Enforce 64KB text limit to safely handle large SDP payloads
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
            String sessionId = (sigMsg.getSessionId() != null && !sigMsg.getSessionId().isBlank())
                    ? sigMsg.getSessionId() : "default-session";
            sigMsg.setSessionId(sessionId);

            log.info("[SignalingHandler] Processing type={}, role={}, deviceId={}, sessionId={}",
                    type, sigMsg.getRole(), sigMsg.getDeviceId(), sessionId);

            switch (type) {
                case "REGISTER":
                    handleRegister(session, sigMsg);
                    break;

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

                case "STREAM_STOPPED":
                case "PEER_DISCONNECTED":
                    handleStreamStopped(session, sigMsg);
                    break;

                case "PING":
                    SignalingMessage pong = new SignalingMessage("PONG", sessionId, sigMsg.getRole(), sigMsg.getDeviceId(), null);
                    sessionManager.sendMessage(session, pong);
                    break;

                default:
                    log.warn("[SignalingHandler] Unknown signaling message type: {}", type);
                    break;
            }

        } catch (Exception e) {
            log.error("[SignalingHandler] Error parsing/handling message: {}", e.getMessage(), e);
            sendErrorMessage(session, "Invalid signaling message format: " + e.getMessage());
        }
    }

    private void handleRegister(WebSocketSession session, SignalingMessage msg) {
        String role = msg.getRole() != null ? msg.getRole().toUpperCase() : "UNKNOWN";
        String deviceId = msg.getDeviceId() != null ? msg.getDeviceId() : ("PHONE".equals(role) ? "phone-1" : "dashboard-1");

        sessionManager.registerClient(session, msg.getSessionId(), role, deviceId);

        // Acknowledge registration to client
        SignalingMessage ack = new SignalingMessage(
                "REGISTERED",
                msg.getSessionId(),
                role,
                deviceId,
                Map.of("status", "SUCCESS", "role", role, "deviceId", deviceId)
        );
        sessionManager.sendMessage(session, ack);
        log.info("[WebSocket] Registered as {} with deviceId={}", role, deviceId);

        if ("PHONE".equals(role)) {
            // Notify existing dashboards that a phone camera has connected and is ready
            SignalingMessage peerMsg = new SignalingMessage(
                    "PEER_CONNECTED",
                    msg.getSessionId(),
                    "PHONE",
                    deviceId,
                    Map.of("role", "PHONE", "deviceId", deviceId)
            );
            sessionManager.forwardToDashboards(msg.getSessionId(), peerMsg);

        } else if ("DASHBOARD".equals(role)) {
            // Check if any phone is already connected and streaming in this session
            List<SessionManager.ClientInfo> phones = sessionManager.getPhonesInSession(msg.getSessionId());
            for (SessionManager.ClientInfo phone : phones) {
                // Notify the dashboard of the phone's presence
                SignalingMessage phonePresentMsg = new SignalingMessage(
                        "PEER_CONNECTED",
                        msg.getSessionId(),
                        "PHONE",
                        phone.getDeviceId(),
                        Map.of("role", "PHONE", "deviceId", phone.getDeviceId())
                );
                sessionManager.sendMessage(session, phonePresentMsg);

                // Ask the phone to initiate an SDP offer to this dashboard
                SignalingMessage requestOfferMsg = new SignalingMessage(
                        "REQUEST_OFFER",
                        msg.getSessionId(),
                        "DASHBOARD",
                        deviceId,
                        Map.of("targetDeviceId", phone.getDeviceId())
                );
                sessionManager.sendMessage(phone.getSession(), requestOfferMsg);
                log.info("[SignalingHandler] Prompted active phone {} to offer to new dashboard", phone.getDeviceId());
            }
        }
    }

    private void handleOffer(WebSocketSession session, SignalingMessage msg) {
        log.info("[WebSocket] Forwarding OFFER from {} (deviceId={}) to dashboard(s)", msg.getRole(), msg.getDeviceId());
        sessionManager.forwardToDashboards(msg.getSessionId(), msg);
    }

    private void handleAnswer(WebSocketSession session, SignalingMessage msg) {
        log.info("[WebSocket] Forwarding ANSWER from {} to target phone: {}", msg.getRole(), msg.getTargetDeviceId());
        sessionManager.forwardToPhone(msg.getSessionId(), msg.getTargetDeviceId(), msg);
    }

    private void handleIceCandidate(WebSocketSession session, SignalingMessage msg) {
        SessionManager.ClientInfo sender = sessionManager.getClient(session);
        if (sender != null && sender.isPhone()) {
            sessionManager.forwardToDashboards(msg.getSessionId(), msg);
        } else if (sender != null && sender.isDashboard()) {
            sessionManager.forwardToPhone(msg.getSessionId(), msg.getTargetDeviceId(), msg);
        } else {
            // If sender not registered yet, use role in message
            if ("PHONE".equalsIgnoreCase(msg.getRole())) {
                sessionManager.forwardToDashboards(msg.getSessionId(), msg);
            } else {
                sessionManager.forwardToPhone(msg.getSessionId(), msg.getTargetDeviceId(), msg);
            }
        }
    }

    private void handleRequestOffer(WebSocketSession session, SignalingMessage msg) {
        log.info("[WebSocket] REQUEST_OFFER received, forwarding to phone(s) in session: {}", msg.getSessionId());
        sessionManager.forwardToPhone(msg.getSessionId(), msg.getTargetDeviceId(), msg);
    }

    private void handleStreamStopped(WebSocketSession session, SignalingMessage msg) {
        log.info("[WebSocket] Stream stopped notification for deviceId={}", msg.getDeviceId());
        sessionManager.forwardToDashboards(msg.getSessionId(), msg);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.error("[WebSocket] Transport error on wsId={}: {}", session.getId(), exception.getMessage());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        SessionManager.ClientInfo removed = sessionManager.removeSession(session);
        if (removed != null) {
            log.info("[WebSocket] Connection closed: role={}, deviceId={}, wsId={}, code={}",
                    removed.getRole(), removed.getDeviceId(), session.getId(), status.getCode());

            if (removed.isPhone()) {
                // Inform dashboards that phone disconnected
                SignalingMessage disconnectMsg = new SignalingMessage(
                        "PEER_DISCONNECTED",
                        removed.getSessionId(),
                        "PHONE",
                        removed.getDeviceId(),
                        Map.of("reason", "Connection closed", "deviceId", removed.getDeviceId())
                );
                sessionManager.forwardToDashboards(removed.getSessionId(), disconnectMsg);
            } else if (removed.isDashboard()) {
                // If dashboard disconnects, notify phone
                SignalingMessage disconnectMsg = new SignalingMessage(
                        "PEER_DISCONNECTED",
                        removed.getSessionId(),
                        "DASHBOARD",
                        removed.getDeviceId(),
                        Map.of("reason", "Dashboard closed")
                );
                sessionManager.forwardToPhone(removed.getSessionId(), null, disconnectMsg);
            }
        }
    }

    private void sendErrorMessage(WebSocketSession session, String errorMsg) {
        SignalingMessage error = new SignalingMessage(
                "ERROR",
                "default-session",
                "SERVER",
                "server",
                Map.of("error", errorMsg)
        );
        sessionManager.sendMessage(session, error);
    }
}
