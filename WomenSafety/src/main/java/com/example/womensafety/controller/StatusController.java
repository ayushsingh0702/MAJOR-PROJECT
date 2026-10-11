package com.example.womensafety.controller;

import com.example.womensafety.model.PairingSession;
import com.example.womensafety.websocket.PairingManager;
import com.example.womensafety.websocket.SessionManager;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.*;

/**
 * Health check, signaling status, and pairing diagnostics controller.
 * Accessible from browser to verify backend availability.
 */
@RestController
@CrossOrigin(origins = "*")
@RequestMapping("/api")
public class StatusController {

    private final SessionManager sessionManager;
    private final PairingManager pairingManager;

    public StatusController(SessionManager sessionManager, PairingManager pairingManager) {
        this.sessionManager = sessionManager;
        this.pairingManager = pairingManager;
    }

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> getStatus() {
        Map<String, Object> status = new HashMap<>();
        status.put("service", "Women Safety WebRTC Signaling Server");
        status.put("status", "UP");
        status.put("websocketEndpoint", "/ws");
        status.put("timestamp", Instant.now().toString());
        status.put("diagnostics", sessionManager.getDiagnostics());

        // Include pairing summary (no sensitive tokens exposed)
        List<Map<String, Object>> pairingSummary = new ArrayList<>();
        for (PairingSession ps : pairingManager.getAllSessions()) {
            Map<String, Object> s = new HashMap<>();
            s.put("sessionId", ps.getSessionId().substring(0, 8) + "..."); // Truncate for safety
            s.put("state", ps.getState().name());
            s.put("pairedAt", ps.getPairedAt() != null ? ps.getPairedAt().toString() : null);
            s.put("expired", ps.isExpired());
            s.put("secondsUntilExpiry", ps.getSecondsUntilExpiry());
            pairingSummary.add(s);
        }
        status.put("pairingSessions", pairingSummary);
        status.put("activePairingSessionCount", pairingSummary.size());

        return ResponseEntity.ok(status);
    }
}
