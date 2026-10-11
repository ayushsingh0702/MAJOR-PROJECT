package com.example.womensafety.model;

import java.time.Instant;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Represents a pairing session between a laptop dashboard and a mobile phone.
 * The dashboard creates this session; the phone joins by providing the pairing code.
 *
 * Security design:
 * - pairingCode: short, human-readable, expires in 2 minutes, single-use
 * - phoneAuthToken: long, cryptographically random, issued on successful pairing,
 *   used to authorize all subsequent signaling messages from the phone
 * - dashboardAuthToken: issued to the dashboard on session creation,
 *   used to authorize all subsequent signaling messages from the dashboard
 */
public class PairingSession {

    public enum State {
        WAITING_FOR_PAIRING,   // Dashboard created session, waiting for phone
        PAIRING_REQUESTED,     // Phone submitted code, awaiting dashboard confirmation
        PAIRED,                // Both sides confirmed
        CAMERA_READY,          // Phone has camera, ready to stream
        STREAMING,             // Active WebRTC stream
        DISCONNECTED,          // Phone disconnected
        UNPAIRED,              // Explicitly unpaired
        EXPIRED                // Pairing code expired before use
    }

    // Pairing session ID - server-assigned, not predictable
    private final String sessionId;

    // Short human-readable code for QR/manual entry, valid 2 minutes, single-use
    private final String pairingCode;

    // When the pairing code expires
    private final Instant expiresAt;

    // Server-assigned auth tokens (never exposed in QR or URL)
    private final String dashboardAuthToken;
    private String phoneAuthToken; // assigned after successful pairing

    // WebSocket IDs of the paired participants
    private String dashboardWsId;
    private String phoneWsId;

    // Device IDs
    private String dashboardDeviceId;
    private String phoneDeviceId;

    // Current state
    private volatile State state;

    // Pairing timestamp
    private Instant pairedAt;

    // Rate limiting: track failed pairing attempts
    private final AtomicInteger failedAttempts = new AtomicInteger(0);
    private static final int MAX_FAILED_ATTEMPTS = 5;

    // Whether code has been consumed (single-use)
    private volatile boolean codeConsumed = false;

    public PairingSession(String sessionId, String pairingCode, Instant expiresAt, String dashboardAuthToken) {
        this.sessionId = sessionId;
        this.pairingCode = pairingCode;
        this.expiresAt = expiresAt;
        this.dashboardAuthToken = dashboardAuthToken;
        this.state = State.WAITING_FOR_PAIRING;
    }

    // -------------------------------------------------------------------------
    // Validation helpers
    // -------------------------------------------------------------------------

    public boolean isExpired() {
        return !Instant.now().isBefore(expiresAt);
    }

    public boolean isCodeConsumed() {
        return codeConsumed;
    }

    public void consumeCode() {
        this.codeConsumed = true;
    }

    public boolean isRateLimited() {
        return failedAttempts.get() >= MAX_FAILED_ATTEMPTS;
    }

    public int incrementFailedAttempts() {
        return failedAttempts.incrementAndGet();
    }

    public boolean isPaired() {
        return state == State.PAIRED || state == State.CAMERA_READY || state == State.STREAMING;
    }

    public boolean isActive() {
        return state != State.UNPAIRED && state != State.EXPIRED;
    }

    // -------------------------------------------------------------------------
    // Getters and Setters
    // -------------------------------------------------------------------------

    public String getSessionId() { return sessionId; }
    public String getPairingCode() { return pairingCode; }
    public Instant getExpiresAt() { return expiresAt; }
    public String getDashboardAuthToken() { return dashboardAuthToken; }

    public String getPhoneAuthToken() { return phoneAuthToken; }
    public void setPhoneAuthToken(String phoneAuthToken) { this.phoneAuthToken = phoneAuthToken; }

    public String getDashboardWsId() { return dashboardWsId; }
    public void setDashboardWsId(String dashboardWsId) { this.dashboardWsId = dashboardWsId; }

    public String getPhoneWsId() { return phoneWsId; }
    public void setPhoneWsId(String phoneWsId) { this.phoneWsId = phoneWsId; }

    public String getDashboardDeviceId() { return dashboardDeviceId; }
    public void setDashboardDeviceId(String dashboardDeviceId) { this.dashboardDeviceId = dashboardDeviceId; }

    public String getPhoneDeviceId() { return phoneDeviceId; }
    public void setPhoneDeviceId(String phoneDeviceId) { this.phoneDeviceId = phoneDeviceId; }

    public State getState() { return state; }
    public void setState(State state) { this.state = state; }

    public Instant getPairedAt() { return pairedAt; }
    public void setPairedAt(Instant pairedAt) { this.pairedAt = pairedAt; }

    public int getFailedAttempts() { return failedAttempts.get(); }

    public long getSecondsUntilExpiry() {
        long remaining = expiresAt.getEpochSecond() - Instant.now().getEpochSecond();
        return Math.max(0, remaining);
    }
}
