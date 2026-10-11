package com.example.womensafety.config;

import com.example.womensafety.websocket.SignalingHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

import java.util.List;

/**
 * Spring Boot WebSocket Configuration for WebRTC signaling.
 * Maps the /ws endpoint for the deployed frontend and local development.
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final SignalingHandler signalingHandler;
    private final List<String> allowedOriginPatterns;

    public WebSocketConfig(
            SignalingHandler signalingHandler,
            @Value("${app.websocket.allowed-origin-patterns}") List<String> allowedOriginPatterns) {
        this.signalingHandler = signalingHandler;
        this.allowedOriginPatterns = allowedOriginPatterns;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(signalingHandler, "/ws")
                .setAllowedOriginPatterns(allowedOriginPatterns.toArray(String[]::new));
    }
}
