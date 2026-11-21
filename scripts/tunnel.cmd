@echo off
rem Start the full StockRadar server and expose it through a Cloudflare quick
rem tunnel, so a phone or a friend can open the real (account-enabled) build.
rem The URL is printed by cloudflared and changes every time it restarts.
chcp 65001 >nul
cd /d "%~dp0.."

if not exist "tools\bin\cloudflared.exe" (
  echo [!] tools\bin\cloudflared.exe not found.
  echo     Download: https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  exit /b 1
)

echo Starting server on http://localhost:5173 ...
start "StockRadar server" cmd /c "node server.js"
timeout /t 3 >nul

echo Starting Cloudflare quick tunnel ...
tools\bin\cloudflared.exe tunnel --url http://localhost:5173 --no-autoupdate
