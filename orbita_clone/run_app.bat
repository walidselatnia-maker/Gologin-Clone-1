@echo off
title Orbita Anti-Detect Browser Manager
cd /d "%~dp0"
echo Starting Orbita Anti-Detect Desktop Manager...
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" main.js
) else (
  start "" npx electron main.js
)
