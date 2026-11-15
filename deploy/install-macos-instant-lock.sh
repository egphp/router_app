#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
BIN_PATH="${BIN_DIR}/macos-instant-lock"
LABEL="com.$(id -un).instant-lock"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

mkdir -p "${BIN_DIR}" "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"

clang -O2 -Wall -Wextra "${SCRIPT_DIR}/macos-instant-lock.c" \
  -framework CoreGraphics \
  -framework CoreFoundation \
  -o "${BIN_PATH}"
chmod 755 "${BIN_PATH}"
codesign --force --sign - "${BIN_PATH}"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BIN_PATH}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/macos-instant-lock.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/macos-instant-lock.launchd.log</string>
</dict>
</plist>
EOF

plutil -lint "${PLIST_PATH}"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
echo "Installed and loaded ${LABEL} -> ${BIN_PATH}"
