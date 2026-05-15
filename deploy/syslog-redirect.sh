#!/usr/bin/env bash
# Configure macOS pf firewall to redirect UDP 514 -> 5140.
# Needed once because the Tenda router sends syslog to a fixed port 514, which
# requires root to bind on; our daemon listens on 5140 (no root required).
# Run with: sudo bash deploy/syslog-redirect.sh
set -e

if [ "$EUID" -ne 0 ]; then
  echo "This script must be run with sudo:"
  echo "  sudo bash deploy/syslog-redirect.sh"
  exit 1
fi

ANCHOR=tenda-syslog
RULES="/etc/pf.anchors/com.tenda-syslog"

cat > "$RULES" <<'EOF'
# Redirect UDP 514 (syslog) to local 5140 where the tenda-monitor poller listens.
rdr pass on lo0 inet proto udp from any to any port 514 -> 127.0.0.1 port 5140
rdr pass inet proto udp from any to any port 514 -> 127.0.0.1 port 5140
EOF

# Inject anchor reference into /etc/pf.conf if not present
if ! grep -q "anchor \"$ANCHOR\"" /etc/pf.conf 2>/dev/null; then
  echo "Adding anchor reference to /etc/pf.conf …"
  sed -i.bak '/^rdr-anchor "com.apple\/\*"/a\
rdr-anchor "'"$ANCHOR"'"
' /etc/pf.conf
fi
if ! grep -q "load anchor \"$ANCHOR\"" /etc/pf.conf 2>/dev/null; then
  echo "load anchor \"$ANCHOR\" from \"$RULES\"" >> /etc/pf.conf
fi

# Enable pf and load
pfctl -e 2>/dev/null || true
pfctl -F all -f /etc/pf.conf
echo
echo "✔ pf redirect installed: UDP 514 -> 127.0.0.1:5140"
echo "  Verify with:    sudo pfctl -s nat"
echo "  Disable with:   sudo pfctl -a $ANCHOR -F all"
