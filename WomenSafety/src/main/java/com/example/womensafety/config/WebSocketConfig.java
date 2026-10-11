package com.example.womensafety.config;

import com.example.womensafety.websocket.SignalingHandler;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * Spring Boot WebSocket Configuration for WebRTC signaling.
 * Maps the /ws endpoint for the deployed frontend and local development.
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final SignalingHandler signalingHandler;

    public WebSocketConfig(SignalingHandler signalingHandler) {
        this.signalingHandler = signalingHandler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(signalingHandler, "/ws")
                .setAllowedOriginPatterns(
                        "https://major-project-frontend-blond.vercel.app",
                        "http://localhost:*",
                        "http://127.0.0.1:*");
    }
}
