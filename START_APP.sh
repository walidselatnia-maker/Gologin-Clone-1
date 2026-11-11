#!/usr/bin/env bash
# Orbita Anti-Detect Browser Profile Manager - Linux Desktop Launcher

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/orbita_clone" || exit 1

echo "======================================================="
echo "  ORBITA ANTI-DETECT BROWSER PROFILE MANAGER (LINUX)   "
echo "  Starting desktop application...                      "
echo "======================================================="

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "Installing required npm dependencies..."
  npm install
fi

# Prefer local Electron binary
if [ -f "node_modules/electron/dist/electron" ]; then
  exec "./node_modules/electron/dist/electron" main.js "$@"
elif [ -f "node_modules/.bin/electron" ]; then
  exec "./node_modules/.bin/electron" main.js "$@"
else
  exec npx electron main.js "$@"
fi
