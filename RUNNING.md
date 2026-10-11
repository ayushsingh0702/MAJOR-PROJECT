# Running the Women Safety application

This project has a Spring Boot signaling backend and a static frontend. Run them
in two separate PowerShell terminals from the repository root.

## Prerequisites

- Java 17 or newer
- Node.js

The backend Maven wrapper is included, so a separate Maven installation is not
required. The frontend has no build step or npm dependencies to install.

## Start the application locally

### Start or restart both servers

From the repository root, run:

```powershell
.\run-local.cmd
```

The launcher checks ports 3000 (frontend) and 8080 (backend), stops an existing
process only if it can identify it as this application's server, then starts
both servers in separate PowerShell windows and opens the dashboard. It does
not clear or stop unrelated ports or processes. If either port belongs to a
different application, the script stops and reports the conflict instead.

### Terminal 1: Spring Boot backend

From the repository root:

```powershell
.\WomenSafety\mvnw.cmd -f WomenSafety\pom.xml spring-boot:run
```

Wait for the log message indicating that Tomcat started on port 8080. The
backend provides:

- Health/status: `http://localhost:8080/api/status`
- WebSocket signaling: `ws://localhost:8080/ws`
- ICE server configuration: `http://localhost:8080/api/ice-servers`

### Terminal 2: frontend

From the repository root:

```powershell
Set-Location frontend
npm.cmd start
```

`npm.cmd` avoids PowerShell execution-policy errors that can occur with
`npm.ps1`. Alternatively, run the server directly:

```powershell
node .\frontend\serve.js
```

Open these pages in a browser:

- Landing page: `http://localhost:3000/index.html`
- Dashboard: `http://localhost:3000/pages/dashboard.html`
- Phone page: `http://localhost:3000/pages/phone.html`

Keep both terminals running while using the application. Press `Ctrl+C` in
each terminal to stop its server. For a local check, verify that
`http://localhost:8080/api/status` returns `"status":"UP"` and that the
dashboard connects to signaling.

### If port 8080 is already in use

This usually means the backend is already running in another terminal. Check
`http://localhost:8080/api/status`; if it returns `"status":"UP"`, leave that
backend running and do not start a second copy. To restart it, press `Ctrl+C` in
the terminal running the backend, then run the start command again.

If you cannot find that terminal, identify the process listening on port 8080:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen |
    Select-Object LocalAddress, LocalPort, OwningProcess
```

Inspect the reported process ID before stopping anything:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = <PID>" |
    Select-Object ProcessId, Name, CommandLine
```

Only if it is the old Women Safety Java backend that you intend to stop, run
`Stop-Process -Id <PID>`. Do not stop a process unless you have verified its
process ID and command line.

## Run tests

From the repository root:

```powershell
.\WomenSafety\mvnw.cmd -f WomenSafety\pom.xml test
```

## Build and run the backend JAR

From the repository root:

```powershell
.\WomenSafety\mvnw.cmd -f WomenSafety\pom.xml package
java -jar .\WomenSafety\target\WomenSafety-0.0.1-SNAPSHOT.jar
```

The package command runs the tests before creating the JAR.

## Optional backend settings

These PowerShell environment variables can be set in the backend terminal before
starting the backend:

```powershell
$env:WEBSOCKET_ALLOWED_ORIGIN_PATTERNS = "https://your-frontend.example,http://localhost:*,http://127.0.0.1:*"
$env:WEBRTC_TURN_URLS = "turn:turn.example.net:3478?transport=udp,turns:turn.example.net:5349?transport=tcp"
$env:WEBRTC_TURN_SHARED_SECRET = "your-provider-shared-secret"
$env:WEBRTC_TURN_CREDENTIAL_TTL_SECONDS = "3600"
.\WomenSafety\mvnw.cmd -f WomenSafety\pom.xml spring-boot:run
```

`WEBSOCKET_ALLOWED_ORIGIN_PATTERNS` is a comma-separated list. The project has
development and Vercel defaults, so it does not need to be set for the standard
local setup. TURN settings are optional; without them the backend supplies
STUN-only ICE configuration. Do not put TURN shared secrets in frontend code or
commit them to Git.

## Using a phone camera

The phone page must be served from a secure context for browser camera access.
For a physical phone, use the deployed HTTPS frontend and a deployed WSS backend,
or another HTTPS development tunnel. A phone opening `localhost` would connect
to the phone itself, not the computer hosting the app. When testing a deployed
frontend, both devices must use the same backend; the dashboard's pairing QR
code includes the signaling URL.
