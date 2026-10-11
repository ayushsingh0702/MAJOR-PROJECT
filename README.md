# Women Safety LIVE WEB TELECASTING SYSTEM

Live peer-to-peer mobile camera streaming to a centralized laptop monitoring dashboard using WebRTC and Spring Boot signaling.

---

## Quick Start

### 1. Start Spring Boot Signaling Server
```powershell
cd WomenSafety
$env:JAVA_HOME = "C:\Users\ayush\.jdks\ms-21.0.12.1"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
.\mvnw.cmd spring-boot:run
```
Signaling endpoint: `ws://localhost:8080/ws`  
Health check: `http://localhost:8080/api/status`

### 2. Build Production JAR
```powershell
cd WomenSafety
.\mvnw.cmd package "-Dmaven.test.skip=true"
java -jar target/WomenSafety-0.0.1-SNAPSHOT.jar
```

### 3. Start Frontend Locally
```powershell
cd frontend
node serve.js
```
- Landing Page: `http://localhost:3000/index.html`
- Laptop Dashboard: `http://localhost:3000/pages/dashboard.html`
- Phone Camera: `http://localhost:3000/pages/phone.html`

---

## Deployed Web Application
- **Frontend URL**: [https://major-project-frontend-blond.vercel.app](https://major-project-frontend-blond.vercel.app)
- **Laptop Dashboard**: [https://major-project-frontend-blond.vercel.app/pages/dashboard.html](https://major-project-frontend-blond.vercel.app/pages/dashboard.html)
- **Phone Pairing Page**: [https://major-project-frontend-blond.vercel.app/pages/phone.html](https://major-project-frontend-blond.vercel.app/pages/phone.html)
- **Connect Deployed Frontend to Backend**: Open the dashboard with `?ws=wss://YOUR-BACKEND-DOMAIN/ws`. Its QR code carries the backend address and one-time pairing code; for manual phone entry, open the phone URL with the same `?ws=...` parameter.
- **Secure pairing**: The dashboard issues a two-minute, single-use code. The phone must pair with it and the user must tap **Start Streaming** before camera access and WebRTC negotiation begin. Pairing authorization is held only in page memory and expires when either WebSocket disconnects.
- **Backend deployment**: Configure the `/ws` endpoint behind HTTPS/WSS, keep port 8080 private behind the tunnel or reverse proxy, and allow the Vercel origin in the WebSocket configuration. The current live pairing store is in-memory, so restarting the backend invalidates active sessions. STUN-only WebRTC can fail across restrictive carrier or enterprise NATs; configure TURN for reliable cross-network connectivity.

## Pairing verification
From `WomenSafety`, run `.\mvnw.cmd test`. The pairing manager tests cover code generation/expiry, single-use consumption, concurrent consumption, failed-attempt rate limiting, and immediate unpair token revocation. Cross-device camera permission, browser QR scanning, and live WebRTC media still require a real HTTPS phone and dashboard connected to a deployed WSS backend.

---

## Complete Documentation
For architectural diagrams, message specifications, testing workflows, and WebRTC troubleshooting guides, see [DOCUMENTATION.md](file:///c:/Users/ayush/OneDrive/Desktop/khoon-passina/Project/DOCUMENTATION.md).
