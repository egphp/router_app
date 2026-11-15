#!/usr/bin/env bash
set -euo pipefail

# Installs a persistent root LaunchDaemon on macOS that assigns two dedicated /32 LAN VIP aliases
# (.241 for WAN1 SSH, .242 for WAN2 SSH) to the Mac's active LAN interface (while keeping .7 as
# the primary load-balanced IP). This solves Tenda W30E's source-IP-only Multi-WAN routing so
# inbound SSH on BOTH WAN1 and WAN2 returns out the exact WAN it arrived on.

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run with sudo:"
  echo "  sudo $0"
  exit 1
fi

HELPER="/usr/local/bin/tenda-ssh-wan-vips"
PLIST="/Library/LaunchDaemons/com.michaeltawfik.ssh-wan-vips.plist"
ROUTER_IP="${ROUTER_HOST:-192.168.0.1}"
PREFIX="${ROUTER_IP%.*}"
VIP1="${PREFIX}.241"
VIP2="${PREFIX}.242"

mkdir -p /usr/local/bin

cat > "${HELPER}" <<EOF
#!/bin/bash
set -u
ROUTER_IP="${ROUTER_IP}"
VIP1="${VIP1}"
VIP2="${VIP2}"

IFACE=\$(/sbin/route -n get "\${ROUTER_IP}" 2>/dev/null | /usr/bin/awk '/interface:/{print \$2; exit}')
if [[ -z "\${IFACE}" ]]; then
  exit 0
fi

CUR=\$(/sbin/ifconfig "\${IFACE}" 2>/dev/null || true)
if [[ -z "\${CUR}" ]] || ! echo "\${CUR}" | /usr/bin/grep -q "inet ${PREFIX}\\."; then
  exit 0
fi

CHANGED=0
if ! echo "\${CUR}" | /usr/bin/grep -q "inet \${VIP1} "; then
  /sbin/ifconfig "\${IFACE}" alias "\${VIP1}" 255.255.255.255 && CHANGED=1
fi
if ! echo "\${CUR}" | /usr/bin/grep -q "inet \${VIP2} "; then
  /sbin/ifconfig "\${IFACE}" alias "\${VIP2}" 255.255.255.255 && CHANGED=1
fi

if [[ "\${CHANGED}" -eq 1 ]]; then
  # Announce ARP to router & trigger Tenda poller to switch port mappings to symmetric VIPs
  /sbin/ping -c 1 -W 300 -S "\${VIP1}" "\${ROUTER_IP}" >/dev/null 2>&1 || true
  /sbin/ping -c 1 -W 300 -S "\${VIP2}" "\${ROUTER_IP}" >/dev/null 2>&1 || true
  /usr/bin/curl -fsS -X POST http://127.0.0.1:3031/ssh-access \\
    -H 'Content-Type: application/json' \\
    -d '{"enabled":true}' >/dev/null 2>&1 || true
fi
EOF

chmod 755 "${HELPER}"
chown root:wheel "${HELPER}"

cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.michaeltawfik.ssh-wan-vips</string>
  <key>ProgramArguments</key>
  <array>
    <string>${HELPER}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>30</integer>
  <key>WatchPaths</key>
  <array>
    <string>/Library/Preferences/SystemConfiguration</string>
  </array>
  <key>StandardOutPath</key>
  <string>/var/log/tenda-ssh-wan-vips.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/tenda-ssh-wan-vips.log</string>
</dict>
</plist>
EOF

chmod 644 "${PLIST}"
chown root:wheel "${PLIST}"
plutil -lint "${PLIST}"

launchctl bootout system/com.michaeltawfik.ssh-wan-vips >/dev/null 2>&1 || true
launchctl bootstrap system "${PLIST}"
launchctl kickstart -k system/com.michaeltawfik.ssh-wan-vips

sleep 1
"${HELPER}"

echo "=== Active VIPs on LAN interface ==="
IFACE=$(/sbin/route -n get "${ROUTER_IP}" | awk '/interface:/{print $2; exit}')
/sbin/ifconfig "${IFACE}" | grep "inet "
echo "SUCCESS: Symmetric Dual-WAN SSH VIPs (${VIP1} -> WAN1, ${VIP2} -> WAN2) installed and synced with Tenda W30E!"
