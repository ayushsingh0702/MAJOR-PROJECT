package com.example.womensafety.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Clean, extensible WebRTC signaling message model.
 * Carries registration, SDP offer/answer, ICE candidates, status events,
 * and pairing protocol messages.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class SignalingMessage {

    // Core types: REGISTER, OFFER, ANSWER, ICE_CANDIDATE, PEER_CONNECTED, PEER_DISCONNECTED, ERROR, PING, PONG
    // Pairing types: CREATE_PAIRING_SESSION, PAIRING_SESSION_CREATED, JOIN_PAIRING_SESSION,
    //                PAIRING_REQUESTED, PAIRING_APPROVED, PAIRING_REJECTED, PAIRING_EXPIRED,
    //                DEVICE_PAIRED, DEVICE_UNPAIRED, STREAM_STARTED, STREAM_STOPPED, DEVICE_DISCONNECTED, UNPAIR
    private String type;

    private String sessionId;       // WebRTC signaling session identifier (legacy, kept for compat)
    private String role;            // PHONE or DASHBOARD
    private String deviceId;        // Unique device ID, e.g. "phone-1"
    private String targetDeviceId;  // Target device ID for multi-camera routing
    private Object payload;         // Offer/Answer SDP object, ICE candidate, or message payload
    private Long timestamp;

    // Pairing protocol fields
    private String pairingCode;        // Human-readable pairing code (phone -> server on JOIN_PAIRING_SESSION)
    private String authToken;          // Auth token (server -> client on pairing; client uses for subsequent messages)
    private String pairingSessionId;   // Server-assigned pairing session ID (NOT client-supplied for security)

    public SignalingMessage() {
        this.timestamp = System.currentTimeMillis();
    }

    public SignalingMessage(String type, String sessionId, String role, String deviceId, Object payload) {
        this.type = type;
        this.sessionId = sessionId;
        this.role = role;
        this.deviceId = deviceId;
        this.payload = payload;
        this.timestamp = System.currentTimeMillis();
    }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }

    public String getRole() { return role; }
    public void setRole(String role) { this.role = role; }

    public String getDeviceId() { return deviceId; }
    public void setDeviceId(String deviceId) { this.deviceId = deviceId; }

    public String getTargetDeviceId() { return targetDeviceId; }
    public void setTargetDeviceId(String targetDeviceId) { this.targetDeviceId = targetDeviceId; }

    public Object getPayload() { return payload; }
    public void setPayload(Object payload) { this.payload = payload; }

    public Long getTimestamp() { return timestamp; }
    public void setTimestamp(Long timestamp) { this.timestamp = timestamp; }

    public String getPairingCode() { return pairingCode; }
    public void setPairingCode(String pairingCode) { this.pairingCode = pairingCode; }

    public String getAuthToken() { return authToken; }
    public void setAuthToken(String authToken) { this.authToken = authToken; }

    public String getPairingSessionId() { return pairingSessionId; }
    public void setPairingSessionId(String pairingSessionId) { this.pairingSessionId = pairingSessionId; }

    @Override
    public String toString() {
        // IMPORTANT: Do NOT include pairingCode or authToken in toString to prevent accidental log exposure
        return "SignalingMessage{" +
                "type='" + type + '\'' +
                ", sessionId='" + sessionId + '\'' +
                ", role='" + role + '\'' +
                ", deviceId='" + deviceId + '\'' +
                ", targetDeviceId='" + targetDeviceId + '\'' +
                ", pairingSessionId='" + pairingSessionId + '\'' +
                '}';
    }
}
