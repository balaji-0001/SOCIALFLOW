# SocialFlow Manager - Development Startup Script
param (
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$rootDir = $PSScriptRoot

Write-Host "=== Starting SocialFlow Manager ===" -ForegroundColor Cyan

# 1. Start PostgreSQL if not already running on port 5433
$pgIsReady = & "C:\Program Files\PostgreSQL\18\bin\pg_isready.exe" -p 5433 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Starting local PostgreSQL on port 5433..." -ForegroundColor Yellow
    if (!(Test-Path "$rootDir\.postgres_data")) {
        & "C:\Program Files\PostgreSQL\18\bin\initdb.exe" -D "$rootDir\.postgres_data" -U postgres -A trust --encoding=UTF8
    }
    & "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" -D "$rootDir\.postgres_data" -l "$rootDir\.postgres_data\pg.log" -o "-p 5433" start
    Start-Sleep -Seconds 2
    # Ensure database exists
    & "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -h localhost -p 5433 -U postgres socialflow 2>$null
} else {
    Write-Host "PostgreSQL is already accepting connections on port 5433." -ForegroundColor Green
}

# 2. Check and push database schema if needed
Write-Host "Verifying database schema..." -ForegroundColor Yellow
$env:DATABASE_URL = "postgresql://postgres@localhost:5433/socialflow"
pnpm.cmd --filter @workspace/db run push

# 3. Start API Server (Background Job or new process)
Write-Host "Starting API server on http://localhost:5000..." -ForegroundColor Yellow
$apiProcess = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$rootDir'; pnpm.cmd --filter @workspace/api-server run dev" -PassThru

# 4. Start Vite Frontend
Write-Host "Starting SocialFlow Web UI on http://localhost:3000..." -ForegroundColor Yellow
if (-not $NoBrowser) {
    Start-Process "http://localhost:3000"
}
pnpm.cmd --filter @workspace/socialflow run dev
