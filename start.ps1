$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$url = "http://127.0.0.1:8000/"
$healthUrl = $url + "api/health"

function Test-AeroAtlasServer {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

if (Test-AeroAtlasServer) {
  Write-Host "AeroAtlas is already running. Opening $url"
  Start-Process $url
  exit 0
}

$python = Join-Path $root "runtime\python.exe"
if (-not (Test-Path $python)) {
  $fallback = Get-Command python -ErrorAction SilentlyContinue
  if ($fallback) {
    $python = $fallback.Source
  } else {
    Write-Host "Python runtime not found. Opening guest mode..."
    Start-Process (Join-Path $root "index.html")
    Read-Host "Press Enter to close"
    exit 1
  }
}

$storage = Join-Path $root "storage"
New-Item -ItemType Directory -Force -Path $storage | Out-Null
$outLog = Join-Path $storage "server.log"
$errLog = Join-Path $storage "server.err.log"

Start-Process -FilePath $python `
  -ArgumentList "server.py --no-browser" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 400
  if (Test-AeroAtlasServer) {
    $ready = $true
    break
  }
}

if ($ready) {
  Write-Host "AeroAtlas is ready. Opening $url"
  Start-Process $url
  exit 0
}

Write-Host "AeroAtlas server did not start."
if (Test-Path $errLog) {
  Write-Host "--- server.err.log ---"
  Get-Content $errLog -Tail 20
}
Read-Host "Press Enter to close"
exit 1
