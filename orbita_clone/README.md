# Orbita Anti-Detect Desktop Manager (Free & Self-Hosted)

A high-performance, local multi-profile anti-detect browser manager replicating GoLogin's core desktop capabilities with native C++ fingerprint spoofing.

---

## Features

- **Native C++ Anti-Detect Engine**: Powered by **GoLogin Orbita Native Chromium** (DRM-free build 146) with hardware Canvas noise, WebGL vendor/renderer spoofing, AudioContext noise, and WebRTC leak protection.
- **Engine Options**: GoLogin Orbita Native Chromium (Default), Camoufox, Google Chrome, and Microsoft Edge.
- **Multi-Profile Isolation**: Each browser profile maintains its own dedicated cookie store, cache, localStorage, and session history (`data/profiles_data/<profileId>`).
- **Hardware & Fingerprint Emulation**:
  - Emulate Windows 11, macOS, or Linux.
  - Custom GPU Renderer selection (NVIDIA RTX 4070, RTX 3080, Intel Iris Xe, AMD Radeon).
  - CPU Cores (4, 8, 12, 16) and RAM (8GB, 16GB, 32GB) allocation.
  - Screen resolution spoofing (1080p, 2K, 1680x1050, 1366x768).
  - One-click **⚡ New Random Fingerprint** generator.
- **Proxy Management**:
  - Supports Direct, HTTP, and SOCKS5 proxies.
  - Live proxy connection checker.
- **Modern Dark UI**: Modeled after GoLogin's dark-slate aesthetic (`#13151b`, `#202431`, `#00b865`).
- **Engine Fallbacks**: Automatically detects Google Chrome and Microsoft Edge on the system for alternate stealth profile launches.

---

## How to Run

### Method 1: Desktop App (Electron)

#### On Linux:
Run the launcher script:
```bash
./START_APP.sh
```
Or from terminal:
```bash
cd orbita_clone
npm run app
```

#### On Windows:
Double-click:
```cmd
START_APP.bat
```
Or run from terminal:
```cmd
cd orbita_clone
npm run app
```

---

### Method 2: Web Interface (Browser)

#### On Linux:
Run:
```bash
./orbita_clone/run_web.sh
```
Or manually:
```bash
cd orbita_clone
node server.js
```
Then navigate to `http://localhost:3030`.

#### On Windows:
Double-click:
```cmd
orbita_clone\run_web.bat
```
Or open `http://localhost:3030` after running `node server.js`.
