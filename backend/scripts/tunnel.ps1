# Starts a Cloudflare quick tunnel to the local API server and prints the
# HTTPS origin to paste into OAUTH_REDIRECT_BASE_URL (.env) and into each
# provider's redirect-URI list. The hostname changes on every run.
#
# Usage:  powershell -File backend/scripts/tunnel.ps1 [-Port 5000]
param([int]$Port = 5000)

$exe = @(
  "C:\Program Files (x86)\cloudflared\cloudflared.exe",
  "C:\Program Files\cloudflared\cloudflared.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { $exe = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source }
if (-not $exe) { Write-Error "cloudflared not found. Install with: winget install --id Cloudflare.cloudflared"; exit 1 }

Write-Host "Starting quick tunnel to http://localhost:$Port ..."
& $exe tunnel --url "http://localhost:$Port" --no-autoupdate 2>&1 | ForEach-Object {
  if ($_ -match "https://[a-z0-9-]+\.trycloudflare\.com") {
    $origin = $Matches[0]
    Write-Host ""
    Write-Host "Tunnel origin:      $origin"
    Write-Host "Set in .env:        OAUTH_REDIRECT_BASE_URL=$origin"
    foreach ($p in "facebook", "instagram", "linkedin", "youtube") {
      Write-Host ("Redirect URI ({0,-9}): {1}/api/connections/{0}/callback" -f $p, $origin)
    }
    Write-Host ""
  }
  $_
}
