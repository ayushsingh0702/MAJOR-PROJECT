package com.example.womensafety.config;

import org.junit.jupiter.api.Test;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class TurnCredentialServiceTests {

    @Test
    void issuesShortLivedAuthenticatedCredentialsForTurnAndTurnsUrls() throws Exception {
        String secret = "test-shared-secret";
        TurnCredentialService service = new TurnCredentialService(
                "turn:relay.example:3478?transport=udp, turns:relay.example:5349?transport=tcp",
                secret,
                600);

        Map<String, Object> response = service.createIceConfiguration();
        assertEquals(true, response.get("turnConfigured"));
        assertTrue((long) response.get("expiresAt") <= Instant.now().getEpochSecond() + 600);
        assertTrue((long) response.get("expiresAt") > Instant.now().getEpochSecond());
        List<?> servers = (List<?>) response.get("iceServers");
        assertEquals(2, servers.size());
        Map<?, ?> turnServer = (Map<?, ?>) servers.get(1);
        assertEquals(List.of(
                "turn:relay.example:3478?transport=udp",
                "turns:relay.example:5349?transport=tcp"), turnServer.get("urls"));

        String username = (String) turnServer.get("username");
        Mac hmac = Mac.getInstance("HmacSHA1");
        hmac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
        String expected = Base64.getEncoder().encodeToString(hmac.doFinal(username.getBytes(StandardCharsets.UTF_8)));
        assertEquals(expected, turnServer.get("credential"));
    }

    @Test
    void doesNotAdvertiseTurnWhenSharedSecretIsMissing() {
        Map<String, Object> response = new TurnCredentialService("turn:relay.example:3478", "", 3600)
                .createIceConfiguration();

        assertEquals(false, response.get("turnConfigured"));
        assertEquals(1, ((List<?>) response.get("iceServers")).size());
    }

    @Test
    void rejectsNonTurnUrlsAndUnsafeCredentialTtls() {
        assertThrows(IllegalArgumentException.class,
                () -> new TurnCredentialService("stun:relay.example:3478", "secret", 3600));
        assertThrows(IllegalArgumentException.class,
                () -> new TurnCredentialService("", "secret", 30));
    }
}
