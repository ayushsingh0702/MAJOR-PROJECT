$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$ports = @{
    3000 = 'frontend'
    8080 = 'backend'
}

foreach ($port in $ports.Keys) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
        if (-not $process) {
            throw "Could not inspect process $($listener.OwningProcess) on port $port. No processes were stopped."
        }

        $isAppProcess = $false
        if ($port -eq 3000) {
            $isAppProcess = $process.Name -eq 'node.exe' -and $process.CommandLine -match 'serve\.js'
        } elseif ($port -eq 8080) {
            $isAppProcess = $process.Name -match '^java(w)?\.exe$' -and
                $process.CommandLine -match 'com\.example\.womensafety\.WomenSafetyApplication'
        }

        if (-not $isAppProcess) {
            throw "Port $port is used by an unrelated process (PID $($process.ProcessId), $($process.Name)). It was not stopped."
        }

        Write-Host "Stopping existing Women Safety $($ports[$port]) process (PID $($process.ProcessId)) on port $port..."
        Stop-Process -Id $process.ProcessId -Force
    }
}

foreach ($port in $ports.Keys) {
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $stillListening = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        if ((Get-Date) -gt $deadline -and $stillListening.Count -gt 0) {
            throw "Port $port did not become available. No new application servers were started."
        }
    } while ($stillListening.Count -gt 0)
}

$backendCommand = '& ".\WomenSafety\mvnw.cmd" -f ".\WomenSafety\pom.xml" spring-boot:run'
$frontendCommand = 'Set-Location -LiteralPath ".\frontend"; node .\serve.js'

Start-Process -FilePath 'powershell.exe' `
    -WorkingDirectory $projectRoot `
    -ArgumentList @('-NoExit', '-Command', $backendCommand) | Out-Null
Start-Process -FilePath 'powershell.exe' `
    -WorkingDirectory $projectRoot `
    -ArgumentList @('-NoExit', '-Command', $frontendCommand) | Out-Null

Write-Host 'Started backend and frontend in separate PowerShell windows. Waiting for them to become ready...'
$deadline = (Get-Date).AddSeconds(120)
$backendReady = $false
$frontendReady = $false

while ((Get-Date) -lt $deadline -and (-not $backendReady -or -not $frontendReady)) {
    if (-not $backendReady) {
        try {
            $statusJson = & curl.exe --silent --show-error --max-time 2 'http://localhost:8080/api/status' 2>$null
            $backendReady = $LASTEXITCODE -eq 0 -and $statusJson -match '"status"\s*:\s*"UP"'
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    if (-not $frontendReady) {
        try {
            $httpStatus = & curl.exe --silent --output NUL --write-out '%{http_code}' --max-time 2 'http://localhost:3000/pages/dashboard.html' 2>$null
            $frontendReady = $LASTEXITCODE -eq 0 -and $httpStatus -eq '200'
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
}

if (-not $backendReady -or -not $frontendReady) {
    throw "Startup timed out. Backend ready: $backendReady; frontend ready: $frontendReady. Check the opened PowerShell windows for errors."
}

Write-Host 'Backend is healthy at http://localhost:8080/api/status'
Write-Host 'Frontend dashboard is ready at http://localhost:3000/pages/dashboard.html'
Start-Process 'http://localhost:3000/pages/dashboard.html'
