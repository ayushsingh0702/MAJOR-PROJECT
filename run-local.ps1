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

$frontendCommand = 'Set-Location -LiteralPath ".\frontend"; node .\serve.js'

Start-Process -FilePath 'powershell.exe' `
    -WorkingDirectory $projectRoot `
    -ArgumentList @('-NoExit', '-Command', $frontendCommand) | Out-Null

Write-Host 'Frontend server started in a separate PowerShell window.'
Write-Host 'Starting backend in this terminal. Keep it open while using the app.'
Write-Host 'After Spring Boot reports that Tomcat started, open http://localhost:3000/pages/dashboard.html'

Set-Location -LiteralPath (Join-Path $projectRoot 'WomenSafety')
& .\mvnw.cmd spring-boot:run
if ($LASTEXITCODE -ne 0) {
    throw "Backend exited with code $LASTEXITCODE. Review the Maven/Spring Boot output above."
}
