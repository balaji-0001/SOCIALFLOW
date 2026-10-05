# SocialFlow Manager - Development Startup Script
param (
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$rootDir = $PSScriptRoot

Write-Host "=== Starting SocialFlow Manager ===" -ForegroundColor Cyan

# 1. Start MySQL if nothing is listening on port 3307 yet. local-mysql\ holds a MySQL server unpacked from the
#    official Windows ZIP (server\) and its data folder (data\); neither is in git. Any other MySQL 8 works too:
#    point DATABASE_URL in .env at it and skip this step.
$mysqlUp = Test-NetConnection -ComputerName 127.0.0.1 -Port 3307 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $mysqlUp) {
    $mysqld = "$rootDir\local-mysql\server\bin\mysqld.exe"
    if (Test-Path $mysqld) {
        Write-Host "Starting local MySQL on port 3307..." -ForegroundColor Yellow
        Start-Process -FilePath $mysqld -WindowStyle Minimized -ArgumentList "--console", "--basedir=$rootDir\local-mysql\server", "--datadir=$rootDir\local-mysql\data", "--port=3307", "--bind-address=127.0.0.1", "--mysqlx=OFF", "--max-connections=300"
        for ($i = 0; $i -lt 30 -and -not (Test-NetConnection -ComputerName 127.0.0.1 -Port 3307 -InformationLevel Quiet -WarningAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
    } else {
        Write-Host "No MySQL on port 3307 and no local-mysql\server found. Start your MySQL server, then run this again." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "MySQL is already accepting connections on port 3307." -ForegroundColor Green
}

# 2. The API creates and updates the tables itself when it starts (backend/db/src/migrate.ts); nothing to push.

# 3. Start API Server (Background Job or new process). It reads DATABASE_URL and the rest from .env.
Write-Host "Starting API server on http://localhost:5000..." -ForegroundColor Yellow
$apiProcess = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$rootDir'; pnpm.cmd --filter @workspace/api-server run dev" -PassThru

# 4. Start Vite Frontend
Write-Host "Starting SocialFlow Web UI on http://localhost:3000..." -ForegroundColor Yellow
if (-not $NoBrowser) {
    Start-Process "http://localhost:3000"
}
pnpm.cmd --filter @workspace/socialflow run dev
