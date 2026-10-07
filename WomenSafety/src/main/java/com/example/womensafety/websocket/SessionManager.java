package com.example.womensafety.websocket;

import com.example.womensafety.model.SignalingMessage;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages active WebSocket signaling sessions, devices, and thread-safe messaging.
 * Extensible to support up to 5 phones and multiple dashboards.
 */
@Component
public class SessionManager {

    private static final Logger log = LoggerFactory.getLogger(SessionManager.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    // Map: WebSocketSession ID -> ClientInfo
    private final Map<String, ClientInfo> sessionClients = new ConcurrentHashMap<>();

    // Map: Session ID (room/group) -> Set of WebSocketSession IDs
    private final Map<String, Set<String>> roomSessions = new ConcurrentHashMap<>();

    public static class ClientInfo {
        private final WebSocketSession session;
        private final String sessionId;
        private final String role; // PHONE or DASHBOARD
        private final String deviceId;

        public ClientInfo(WebSocketSession session, String sessionId, String role, String deviceId) {
            this.session = session;
            this.sessionId = sessionId;
            this.role = role != null ? role.toUpperCase() : "UNKNOWN";
            this.deviceId = deviceId != null ? deviceId : UUID.randomUUID().toString().substring(0, 8);
        }

        public WebSocketSession getSession() {
            return session;
        }

        public String getSessionId() {
            return sessionId;
        }

        public String getRole() {
            return role;
        }

        public String getDeviceId() {
            return deviceId;
        }

        public boolean isPhone() {
            return "PHONE".equalsIgnoreCase(role);
        }

        public boolean isDashboard() {
            return "DASHBOARD".equalsIgnoreCase(role);
        }
    }

    /**
     * Register a connected client with its role and device identity.
     */
    public synchronized void registerClient(WebSocketSession session, String sessionId, String role, String deviceId) {
        String effectiveSessionId = (sessionId != null && !sessionId.isBlank()) ? sessionId : "default-session";
        String effectiveDeviceId = (deviceId != null && !deviceId.isBlank()) ? deviceId :
                ("PHONE".equalsIgnoreCase(role) ? "phone-" + UUID.randomUUID().toString().substring(0, 6) : "dashboard-1");

        ClientInfo clientInfo = new ClientInfo(session, effectiveSessionId, role, effectiveDeviceId);
        sessionClients.put(session.getId(), clientInfo);

        roomSessions.computeIfAbsent(effectiveSessionId, k -> ConcurrentHashMap.newKeySet()).add(session.getId());

        log.info("[SessionManager] Registered client: role={}, deviceId={}, sessionId={}, wsId={}",
                clientInfo.getRole(), clientInfo.getDeviceId(), clientInfo.getSessionId(), session.getId());
    }

    /**
     * Remove a client when its WebSocket connection closes or errors.
     */
    public synchronized ClientInfo removeSession(WebSocketSession session) {
        ClientInfo clientInfo = sessionClients.remove(session.getId());
        if (clientInfo != null) {
            Set<String> members = roomSessions.get(clientInfo.getSessionId());
            if (members != null) {
                members.remove(session.getId());
                if (members.isEmpty()) {
                    roomSessions.remove(clientInfo.getSessionId());
                }
            }
            log.info("[SessionManager] Unregistered client: role={}, deviceId={}, sessionId={}, wsId={}",
                    clientInfo.getRole(), clientInfo.getDeviceId(), clientInfo.getSessionId(), session.getId());
        }
        return clientInfo;
    }

    /**
     * Get ClientInfo for a given WebSocketSession.
     */
    public ClientInfo getClient(WebSocketSession session) {
        return sessionClients.get(session.getId());
    }

    /**
     * Get all active dashboards in a specific session.
     */
    public List<ClientInfo> getDashboardsInSession(String sessionId) {
        Set<String> sessionWsIds = roomSessions.get(sessionId);
        if (sessionWsIds == null) return Collections.emptyList();

        List<ClientInfo> dashboards = new ArrayList<>();
        for (String wsId : sessionWsIds) {
            ClientInfo client = sessionClients.get(wsId);
            if (client != null && client.isDashboard() && client.getSession().isOpen()) {
                dashboards.add(client);
            }
        }
        return dashboards;
    }

    /**
     * Get all active phones in a specific session.
     */
    public List<ClientInfo> getPhonesInSession(String sessionId) {
        Set<String> sessionWsIds = roomSessions.get(sessionId);
        if (sessionWsIds == null) return Collections.emptyList();

        List<ClientInfo> phones = new ArrayList<>();
        for (String wsId : sessionWsIds) {
            ClientInfo client = sessionClients.get(wsId);
            if (client != null && client.isPhone() && client.getSession().isOpen()) {
                phones.add(client);
            }
        }
        return phones;
    }

    /**
     * Find a specific phone by device ID in a session.
     */
    public Optional<ClientInfo> findPhone(String sessionId, String deviceId) {
        return getPhonesInSession(sessionId).stream()
                .filter(p -> p.getDeviceId().equalsIgnoreCase(deviceId))
                .findFirst();
    }

    /**
     * Thread-safe message delivery to a single WebSocketSession.
     */
    public boolean sendMessage(WebSocketSession session, SignalingMessage message) {
        if (session == null || !session.isOpen()) {
            return false;
        }

        try {
            String json = objectMapper.writeValueAsString(message);
            // Synchronize on the session to prevent concurrent WebSocket write clashes
            synchronized (session) {
                if (session.isOpen()) {
                    session.sendMessage(new TextMessage(json));
                    return true;
                }
            }
        } catch (IOException e) {
            log.error("[SessionManager] Error sending message to wsId={}: {}", session.getId(), e.getMessage());
        }
        return false;
    }

    /**
     * Forward a signaling message to all dashboards in the same session.
     */
    public void forwardToDashboards(String sessionId, SignalingMessage message) {
        List<ClientInfo> dashboards = getDashboardsInSession(sessionId);
        for (ClientInfo db : dashboards) {
            sendMessage(db.getSession(), message);
        }
    }

    /**
     * Forward a signaling message to a target phone, or all phones if no target specified.
     */
    public void forwardToPhone(String sessionId, String targetDeviceId, SignalingMessage message) {
        if (targetDeviceId != null && !targetDeviceId.isBlank()) {
            Optional<ClientInfo> target = findPhone(sessionId, targetDeviceId);
            if (target.isPresent()) {
                sendMessage(target.get().getSession(), message);
                return;
            }
        }

        // If no targetDeviceId was specified, send to first or all phones in session
        List<ClientInfo> phones = getPhonesInSession(sessionId);
        for (ClientInfo phone : phones) {
            sendMessage(phone.getSession(), message);
        }
    }

    /**
     * Diagnostic summary
     */
    public Map<String, Object> getDiagnostics() {
        Map<String, Object> diag = new HashMap<>();
        diag.put("totalActiveConnections", sessionClients.size());
        diag.put("activeRooms", roomSessions.size());

        List<Map<String, String>> clientsList = new ArrayList<>();
        for (ClientInfo info : sessionClients.values()) {
            Map<String, String> c = new HashMap<>();
            c.put("role", info.getRole());
            c.put("deviceId", info.getDeviceId());
            c.put("sessionId", info.getSessionId());
            c.put("wsId", info.getSession().getId());
            c.put("isOpen", String.valueOf(info.getSession().isOpen()));
            clientsList.add(c);
        }
        diag.put("clients", clientsList);
        return diag;
    }
}
