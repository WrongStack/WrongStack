#!/usr/bin/env pwsh
# WrongStack Development Environment
# WebUI runs standalone with its own backend (Agent + WebSocket server)

param([switch]$Background)

$ErrorActionPreference = "Continue"
# PS 7.3+: don't let native-command stderr lines escalate into terminating errors.
# pnpm prints the script body (e.g. "$ vite build && node build-package.mjs") to stderr, which would
# otherwise throw under ErrorActionPreference = "Stop".
$PSNativeCommandUseErrorActionPreference = $false

$WEBSOCKET_PORT = 3457
$WEBUI_PORT = 3456

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "     WrongStack Dev Environment" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if pnpm is available
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "Error: pnpm not found" -ForegroundColor Red
    Write-Host "Install: npm install -g pnpm"
    exit 1
}

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Get-Location }

function Stop-PortListeners {
    param([int]$Port, [string]$Label)
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { return }
    $owners = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $owners) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        Write-Host "  Freeing port $Port ($Label): killing PID $procId ($($proc.ProcessName))" -ForegroundColor DarkYellow
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 300
}

function Stop-ProcessTree {
    param([int]$RootPid)
    if (-not $RootPid) { return }
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootPid" -ErrorAction SilentlyContinue
    foreach ($child in $children) { Stop-ProcessTree -RootPid $child.ProcessId }
    Stop-Process -Id $RootPid -Force -ErrorAction SilentlyContinue
}

Write-Host "[1/3] Installing dependencies..." -ForegroundColor Green
# --ignore-scripts, then rebuild an explicit list. Every one of CI's installs
# does this; the dev entrypoint was the one path that let an arbitrary
# dependency's install lifecycle run, which is the machine where a compromised
# postinstall would find real credentials. The list matches `pnpm rebuild` in
# .github/workflows/ci.yml and `allowBuilds` in pnpm-workspace.yaml — keep the
# three in step.
pnpm install --ignore-scripts --silent 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    pnpm install --ignore-scripts
    if ($LASTEXITCODE -ne 0) {
        Write-Host "pnpm install failed (exit $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
}
pnpm rebuild electron-winstaller esbuild node-pty
if ($LASTEXITCODE -ne 0) {
    Write-Host "Native dependency rebuild failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

Write-Host "[2/3] Building WebUI package (frontend + backend)..." -ForegroundColor Green
pnpm --filter=@wrongstack/webui run build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "WebUI build failed (exit $LASTEXITCODE). Re-running with output:" -ForegroundColor Red
    pnpm --filter=@wrongstack/webui run build
    exit 1
}

Write-Host ""
Write-Host "Freeing dev ports (if held by stale processes)..." -ForegroundColor Green
Stop-PortListeners -Port $WEBSOCKET_PORT -Label "Backend"
Stop-PortListeners -Port $WEBUI_PORT     -Label "WebUI"

Write-Host ""
Write-Host "Services:" -ForegroundColor Cyan
Write-Host "  WebUI     -> http://localhost:$WEBUI_PORT" -ForegroundColor Yellow
Write-Host "  Backend   -> ws://localhost:$WEBSOCKET_PORT" -ForegroundColor Yellow
Write-Host ""

if ($Background) {
    Write-Host "[3/3] Starting services in background..." -ForegroundColor Green

    $wsJob = Start-Job -Name "Backend" -ScriptBlock {
        param($dir, $port)
        Set-Location $dir
        $env:WS_PORT = $port
        node packages/webui-server/dist/server/entry.js
    } -ArgumentList $ScriptDir, $WEBSOCKET_PORT

    $webuiJob = Start-Job -Name "WebUI" -ScriptBlock {
        param($dir, $port)
        Set-Location "$dir\packages\webui"
        pnpm run dev
    } -ArgumentList $ScriptDir, $WEBUI_PORT

    Write-Host ""
    Write-Host "OK - Services started" -ForegroundColor Green
    Write-Host "  Backend Job: $($wsJob.Id)"
    Write-Host "  WebUI Job: $($webuiJob.Id)"
    Write-Host ""
    Write-Host "Logs: Get-Job -Id $($wsJob.Id),$($webuiJob.Id) | Receive-Job"
    Write-Host "Stop: Stop-Job -Id $($wsJob.Id),$($webuiJob.Id); Remove-Job -Id $($wsJob.Id),$($webuiJob.Id)"
} else {
    Write-Host "[3/3] Starting services (Ctrl+C to stop)..." -ForegroundColor Green
    Write-Host ""

    $pids = @()

    try {
        # Start WebUI backend (Agent + WebSocket server)
        $env:WS_PORT = $WEBSOCKET_PORT
        $wsProc = Start-Process -FilePath "node" -ArgumentList "packages/webui-server/dist/server/entry.js" -PassThru -NoNewWindow -WorkingDirectory $ScriptDir
        $pids += $wsProc.Id
        Write-Host "  Backend started (PID: $($wsProc.Id))" -ForegroundColor Cyan

        Start-Sleep -Seconds 2
        if (-not (Get-Process -Id $wsProc.Id -ErrorAction SilentlyContinue)) {
            Write-Host "Backend exited during startup - check the log above (likely port $WEBSOCKET_PORT still in use, or runtime error)." -ForegroundColor Red
            exit 1
        }

        # Start WebUI frontend (Vite dev server)
        $webuiProc = Start-Process -FilePath "cmd" -ArgumentList "/c","pnpm run dev" -PassThru -NoNewWindow -WorkingDirectory "$ScriptDir\packages\webui"
        $pids += $webuiProc.Id
        Write-Host "  WebUI started (PID: $($webuiProc.Id))" -ForegroundColor Cyan

        Write-Host ""
        Write-Host "OK - All services running" -ForegroundColor Green
        Write-Host ""
        Write-Host "Open: http://localhost:$WEBUI_PORT" -ForegroundColor Yellow

        while ($true) {
            Start-Sleep -Seconds 1
            $dead = $pids | Where-Object { -not (Get-Process -Id $_ -ErrorAction SilentlyContinue) }
            if ($dead) { break }
        }
    }
    finally {
        Write-Host ""
        Write-Host "Shutting down..." -ForegroundColor Yellow
        foreach ($procId in $pids) {
            # Kill the whole tree - Start-Process with cmd /c pnpm leaves node/vite as grandchildren.
            Stop-ProcessTree -RootPid $procId
        }
        # Belt-and-suspenders: anything still holding the dev ports gets cleaned too.
        Stop-PortListeners -Port $WEBSOCKET_PORT -Label "Backend"
        Stop-PortListeners -Port $WEBUI_PORT     -Label "WebUI"
    }
}
