@echo off
chcp 65001 >nul
rem Daily data sync for StockRadar. Scheduled by Windows Task Scheduler.
rem Usage: daily-sync.cmd [quick]   (quick = quotes only, for a smoke test)
setlocal
cd /d "%~dp0.."
set NODE=D:\node.exe
set LOG=data\sync.log

echo. >> "%LOG%"
echo ==== %DATE% %TIME% start (%~1) ==== >> "%LOG%"

"%NODE%" scripts\sync-a-shares.js >> "%LOG%" 2>&1
if errorlevel 1 goto failed

"%NODE%" scripts\check-data.js >> "%LOG%" 2>&1
if errorlevel 1 goto failed

if /i "%~1"=="quick" goto done

"%NODE%" scripts\sync-sectors.js >> "%LOG%" 2>&1
"%NODE%" scripts\sync-history.js >> "%LOG%" 2>&1
"%NODE%" scripts\sync-profiles.js >> "%LOG%" 2>&1
"%NODE%" scripts\sync-news.js >> "%LOG%" 2>&1
"%NODE%" scripts\sync-macro.js >> "%LOG%" 2>&1
"%NODE%" scripts\sync-flow.js >> "%LOG%" 2>&1

:done
echo ==== %DATE% %TIME% done ==== >> "%LOG%"
exit /b 0

:failed
echo ==== %DATE% %TIME% FAILED ==== >> "%LOG%"
exit /b 1
