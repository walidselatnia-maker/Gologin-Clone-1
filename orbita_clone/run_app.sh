#!/usr/bin/env bash
# Orbita Anti-Detect Desktop Manager Launcher (Linux)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

echo "Starting Orbita Anti-Detect Desktop Manager..."

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "Installing required npm dependencies..."
  npm install
fi

if [ -f "node_modules/electron/dist/electron" ]; then
  exec "./node_modules/electron/dist/electron" main.js "$@"
elif [ -f "node_modules/.bin/electron" ]; then
  exec "./node_modules/.bin/electron" main.js "$@"
else
  exec npx electron main.js "$@"
fi
