@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force; Write-Host 'AeroAtlas server stopped.' } else { Write-Host 'AeroAtlas server is not running.' }"
timeout /t 2 >nul
