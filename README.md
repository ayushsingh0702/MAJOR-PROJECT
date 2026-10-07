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
- **Connect Deployed Frontend to Backend**: Append `?ws=wss://YOUR-BACKEND-DOMAIN/ws` to the URL.

---

## Complete Documentation
For architectural diagrams, message specifications, testing workflows, and WebRTC troubleshooting guides, see [DOCUMENTATION.md](file:///c:/Users/ayush/OneDrive/Desktop/khoon-passina/Project/DOCUMENTATION.md).
