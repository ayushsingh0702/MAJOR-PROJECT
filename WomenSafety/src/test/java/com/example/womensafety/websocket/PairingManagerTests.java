package com.example.womensafety.websocket;

import com.example.womensafety.model.PairingSession;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class PairingManagerTests {

    @Test
    void createsUnpredictableOneTimeCodesAndRevokesPhoneAuthorization() throws Exception {
        PairingManager manager = new PairingManager();
        PairingSession created = manager.createPairingSession("dashboard-ws-1", "client-device-id");

        assertTrue(created.getPairingCode().matches("[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}"));
        assertNotEquals("client-device-id", created.getDashboardDeviceId());
        assertEquals(PairingSession.State.WAITING_FOR_PAIRING, created.getState());

        PairingSession paired = manager.attemptPairing(
                created.getPairingCode().toLowerCase(), "phone-ws-1", "untrusted-device", "203.0.113.1");
        String phoneToken = paired.getPhoneAuthToken();
        assertTrue(paired.isPaired());
        assertEquals("phone-ws-1", manager.getAuthorizedSession("phone-ws-1").getPhoneWsId());
        assertNotEquals("untrusted-device", paired.getPhoneDeviceId());

        PairingManager.PairingException reuse = assertThrows(
                PairingManager.PairingException.class,
                () -> manager.attemptPairing(created.getPairingCode(), "phone-ws-2", null, "203.0.113.2"));
        assertEquals("CODE_CONSUMED", reuse.getErrorCode());

        manager.unpair(paired.getSessionId());
        assertEquals(PairingSession.State.UNPAIRED, paired.getState());
        assertNull(paired.getPhoneAuthToken());
        assertNull(manager.validatePhoneToken(phoneToken));
        assertNull(manager.getAuthorizedSession("phone-ws-1"));
    }

    @Test
    void rejectsPairingAttemptsAfterSourceRateLimit() {
        PairingManager manager = new PairingManager();
        for (int attempt = 0; attempt < 10; attempt++) {
            PairingManager.PairingException rejected = assertThrows(
                    PairingManager.PairingException.class,
                    () -> manager.attemptPairing("BAD-CODE", "phone-ws-" + ThreadLocalRandom.current().nextInt(),
                            null, "203.0.113.8"));
            assertEquals("INVALID_CODE", rejected.getErrorCode());
        }

        PairingManager.PairingException limited = assertThrows(
                PairingManager.PairingException.class,
                () -> manager.attemptPairing("ANOTHER", "phone-ws-final", null, "203.0.113.8"));
        assertEquals("RATE_LIMITED", limited.getErrorCode());
    }

    @Test
    void onlyOneConcurrentRequestCanConsumeTheCode() throws Exception {
        PairingManager manager = new PairingManager();
        PairingSession created = manager.createPairingSession("dashboard-ws", "device");
        ExecutorService executor = Executors.newFixedThreadPool(2);
        AtomicInteger phoneIds = new AtomicInteger();
        try {
            Callable<Boolean> join = () -> {
                try {
                    manager.attemptPairing(created.getPairingCode(), "phone-" + phoneIds.incrementAndGet(),
                            null, "203.0.113.9");
                    return true;
                } catch (PairingManager.PairingException exception) {
                    return false;
                }
            };
            Future<Boolean> first = executor.submit(join);
            Future<Boolean> second = executor.submit(join);
            assertNotEquals(first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS));
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void pairingSessionExpiresAtItsExpiryInstant() {
        PairingSession session = new PairingSession("session", "ABC-234",
                Instant.now().minusSeconds(1), "dashboard-token");

        assertTrue(session.isExpired());
    }
}
