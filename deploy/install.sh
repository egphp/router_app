#!/usr/bin/env bash
# Tenda Monitor — install launchd agents so poller + web start at login and stay running.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH; install Node.js >= 22 first"
  exit 1
fi

LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/tenda-monitor"
mkdir -p "$LAUNCH_DIR" "$LOG_DIR"

# Find the Next.js JS entry (the bin in dist/bin/next, NOT the .bin/ shell wrapper which won't run under node)
NEXT_BIN="$(find "$REPO/node_modules" -name 'next' -type f -path '*/dist/bin/next' 2>/dev/null | head -1)"
if [ -z "$NEXT_BIN" ]; then
  echo "Could not find next/dist/bin/next; run pnpm install first"
  exit 1
fi

# Template substitution
substitute() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s#/usr/local/bin/node#$NODE_BIN#g" \
    -e "s#/Users/michaeltawfik/Documents/tenda_traffic#$REPO#g" \
    -e "s#/Users/michaeltawfik/Library/Logs/tenda-monitor#$LOG_DIR#g" \
    "$src" > "$dst"
}

substitute "$REPO/deploy/com.tenda.monitor.poller.plist" "$LAUNCH_DIR/com.tenda.monitor.poller.plist"
substitute "$REPO/deploy/com.tenda.monitor.web.plist" "$LAUNCH_DIR/com.tenda.monitor.web.plist"

# Patch the web plist to use the discovered Next bin
if [ -n "$NEXT_BIN" ]; then
  /usr/bin/sed -i '' -E "s#<string>[^<]*next/dist/bin/next</string>#<string>$NEXT_BIN</string>#" "$LAUNCH_DIR/com.tenda.monitor.web.plist"
fi

launchctl unload "$LAUNCH_DIR/com.tenda.monitor.poller.plist" 2>/dev/null || true
launchctl unload "$LAUNCH_DIR/com.tenda.monitor.web.plist" 2>/dev/null || true
launchctl load -w "$LAUNCH_DIR/com.tenda.monitor.poller.plist"
launchctl load -w "$LAUNCH_DIR/com.tenda.monitor.web.plist"

echo ""
echo "✔ Installed launchd agents:"
echo "   - $LAUNCH_DIR/com.tenda.monitor.poller.plist"
echo "   - $LAUNCH_DIR/com.tenda.monitor.web.plist"
echo "   Logs: $LOG_DIR/"
echo ""
echo "Dashboard: http://localhost:3030"
echo ""
echo "Manage:"
echo "  launchctl unload $LAUNCH_DIR/com.tenda.monitor.poller.plist  # stop poller"
echo "  launchctl load -w $LAUNCH_DIR/com.tenda.monitor.poller.plist # start poller"
echo "  tail -f $LOG_DIR/poller.log"
