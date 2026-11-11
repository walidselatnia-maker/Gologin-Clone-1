#!/usr/bin/env bash
# Orbita Anti-Detect Manager (Web Interface Launcher)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

echo "Starting Orbita Anti-Detect Manager (Web Interface)..."

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "Installing required npm dependencies..."
  npm install
fi

# Attempt to open web browser
if command -v xdg-open >/dev/null 2>&1; then
  (sleep 1 && xdg-open "http://localhost:3030") >/dev/null 2>&1 &
elif command -v sensible-browser >/dev/null 2>&1; then
  (sleep 1 && sensible-browser "http://localhost:3030") >/dev/null 2>&1 &
fi

exec node server.js
