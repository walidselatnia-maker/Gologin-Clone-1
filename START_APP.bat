@echo off
title Orbita Anti-Detect Browser Manager
cd /d "%~dp0orbita_clone"
echo =======================================================
echo   ORBITA ANTI-DETECT BROWSER PROFILE MANAGER
echo   Starting desktop application...
echo =======================================================
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" main.js
) else (
  start "" npx electron main.js
)
