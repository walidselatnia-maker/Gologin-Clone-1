@echo off
title Orbita Anti-Detect Browser Manager
cd /d "%~dp0"
echo Starting Orbita Anti-Detect Manager...
start "" "http://localhost:3030"
node server.js
