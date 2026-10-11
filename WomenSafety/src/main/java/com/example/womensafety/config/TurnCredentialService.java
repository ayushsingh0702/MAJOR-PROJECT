package com.example.womensafety.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class TurnCredentialService {

    private final List<String> turnUrls;
    private final String sharedSecret;
    private final long credentialTtlSeconds;

    public TurnCredentialService(
            @Value("${webrtc.turn.urls:}") String configuredUrls,
            @Value("${webrtc.turn.shared-secret:}") String sharedSecret,
            @Value("${webrtc.turn.credential-ttl-seconds:3600}") long credentialTtlSeconds) {
        this.turnUrls = parseTurnUrls(configuredUrls);
        this.sharedSecret = sharedSecret == null ? "" : sharedSecret.trim();
        if (credentialTtlSeconds < 60 || credentialTtlSeconds > 86400) {
            throw new IllegalArgumentException("TURN credential TTL must be between 60 and 86400 seconds");
        }
        this.credentialTtlSeconds = credentialTtlSeconds;
    }

    public Map<String, Object> createIceConfiguration() {
        List<Map<String, Object>> iceServers = new ArrayList<>();
        iceServers.add(Map.of("urls", List.of(
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302",
                "stun:stun2.l.google.com:19302")));

        boolean turnConfigured = !turnUrls.isEmpty() && !sharedSecret.isBlank();
        long expiresAt = Instant.now().getEpochSecond() + credentialTtlSeconds;
        if (turnConfigured) {
            String username = expiresAt + ":" + java.util.UUID.randomUUID();
            Map<String, Object> turnServer = new LinkedHashMap<>();
            turnServer.put("urls", turnUrls);
            turnServer.put("username", username);
            turnServer.put("credential", createCredential(username));
            iceServers.add(turnServer);
        }

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("iceServers", iceServers);
        response.put("turnConfigured", turnConfigured);
        response.put("expiresAt", expiresAt);
        return response;
    }

    private String createCredential(String username) {
        try {
            Mac hmac = Mac.getInstance("HmacSHA1");
            hmac.init(new SecretKeySpec(sharedSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
            return Base64.getEncoder().encodeToString(hmac.doFinal(username.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception exception) {
            throw new IllegalStateException("Unable to create TURN credentials", exception);
        }
    }

    private static List<String> parseTurnUrls(String configuredUrls) {
        if (configuredUrls == null || configuredUrls.isBlank()) {
            return List.of();
        }
        List<String> urls = new ArrayList<>();
        for (String value : configuredUrls.split(",")) {
            String url = value.trim();
            if (!(url.startsWith("turn:") || url.startsWith("turns:"))) {
                throw new IllegalArgumentException("TURN URLs must use the turn: or turns: scheme");
            }
            if (url.length() <= (url.startsWith("turns:") ? 6 : 5)) {
                throw new IllegalArgumentException("TURN URL must include a server address");
            }
            urls.add(url);
        }
        return List.copyOf(urls);
    }
}
