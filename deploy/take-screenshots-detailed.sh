#!/usr/bin/env bash
# Detailed screenshot capture for README — every page in every state (default,
# alternative tabs, edit mode, mobile sizes). Uses the same privacy mask as the
# main screenshot script.

set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[[ ! -x "$CHROME" ]] && CHROME="google-chrome"
OUT="${OUT:-docs/screenshots}"
BASE="${BASE:-http://localhost:3030}"

mkdir -p "$OUT" "$OUT/widgets" "$OUT/states" "$OUT/mobile"

MASK_HASH="#__mask__"

shoot() {
  local name="$1" path="$2" w="${3:-1440}" h="${4:-1100}"
  "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=$w,$h --virtual-time-budget=8000 \
    --screenshot="$OUT/${name}.png" "$BASE${path}${MASK_HASH}" 2>/dev/null
  echo "  ✓ $OUT/${name}.png"
}

# --- Main pages (default) ---
echo "[main]"
shoot dashboard ""
shoot devices /devices
shoot consumption /consumption
shoot report /report
shoot analytics /analytics
shoot security /security
shoot attacks /attacks
shoot alerts /alerts
shoot outages /outages
shoot export /export
shoot settings /settings
shoot map /map
shoot setup "/setup?force=1"

# --- Mobile viewports ---
echo "[mobile]"
shoot mobile/dashboard-iphone "" 414 900
shoot mobile/consumption-iphone /consumption 414 900
shoot mobile/devices-iphone /devices 414 900
shoot mobile/alerts-iphone /alerts 414 900
shoot mobile/settings-iphone /settings 414 900

# --- Tablet viewport ---
echo "[tablet]"
shoot mobile/dashboard-tablet "" 768 1024
shoot mobile/devices-tablet /devices 768 1024

echo "Done. Review images before committing."
