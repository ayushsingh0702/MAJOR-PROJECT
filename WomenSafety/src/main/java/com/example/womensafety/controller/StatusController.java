package com.example.womensafety.controller;

import com.example.womensafety.websocket.SessionManager;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * Health check and signaling status controller.
 * Accessible from browser to verify backend availability.
 */
@RestController
@CrossOrigin(origins = "*")
@RequestMapping("/api")
public class StatusController {

    private final SessionManager sessionManager;

    public StatusController(SessionManager sessionManager) {
        this.sessionManager = sessionManager;
    }

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> getStatus() {
        Map<String, Object> status = new HashMap<>();
        status.put("service", "Women Safety WebRTC Signaling Server");
        status.put("status", "UP");
        status.put("websocketEndpoint", "/ws");
        status.put("timestamp", Instant.now().toString());
        status.put("diagnostics", sessionManager.getDiagnostics());
        return ResponseEntity.ok(status);
    }
}
