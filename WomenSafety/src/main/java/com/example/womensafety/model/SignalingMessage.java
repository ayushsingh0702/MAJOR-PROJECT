package com.example.womensafety.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Clean, extensible WebRTC signaling message model.
 * Carries registration, SDP offer/answer, ICE candidates, and status events.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class SignalingMessage {

    private String type;            // REGISTER, OFFER, ANSWER, ICE_CANDIDATE, PEER_CONNECTED, PEER_DISCONNECTED, ERROR, PING, PONG
    private String sessionId;       // Session identifier (e.g. "default-session")
    private String role;            // PHONE or DASHBOARD
    private String deviceId;        // Unique device ID, e.g. "phone-1"
    private String targetDeviceId;  // Target device ID for multi-camera routing
    private Object payload;         // Offer/Answer SDP object, ICE candidate, or message payload
    private Long timestamp;

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

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getSessionId() {
        return sessionId;
    }

    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    public String getRole() {
        return role;
    }

    public void setRole(String role) {
        this.role = role;
    }

    public String getDeviceId() {
        return deviceId;
    }

    public void setDeviceId(String deviceId) {
        this.deviceId = deviceId;
    }

    public String getTargetDeviceId() {
        return targetDeviceId;
    }

    public void setTargetDeviceId(String targetDeviceId) {
        this.targetDeviceId = targetDeviceId;
    }

    public Object getPayload() {
        return payload;
    }

    public void setPayload(Object payload) {
        this.payload = payload;
    }

    public Long getTimestamp() {
        return timestamp;
    }

    public void setTimestamp(Long timestamp) {
        this.timestamp = timestamp;
    }

    @Override
    public String toString() {
        return "SignalingMessage{" +
                "type='" + type + '\'' +
                ", sessionId='" + sessionId + '\'' +
                ", role='" + role + '\'' +
                ", deviceId='" + deviceId + '\'' +
                ", targetDeviceId='" + targetDeviceId + '\'' +
                '}';
    }
}
