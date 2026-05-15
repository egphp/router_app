#!/usr/bin/env bash
set -e
LAUNCH_DIR="$HOME/Library/LaunchAgents"
launchctl unload "$LAUNCH_DIR/com.tenda.monitor.poller.plist" 2>/dev/null || true
launchctl unload "$LAUNCH_DIR/com.tenda.monitor.web.plist" 2>/dev/null || true
rm -f "$LAUNCH_DIR/com.tenda.monitor.poller.plist" "$LAUNCH_DIR/com.tenda.monitor.web.plist"
echo "✔ Removed launchd agents"
