#!/usr/bin/env bash
# Capture dashboard screenshots with sensitive data (MACs, real hostnames) masked.
# Uses Chrome headless + a small JS injection that walks the DOM and replaces
# MAC addresses + identifiable host labels with placeholders before the snapshot.

set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[[ ! -x "$CHROME" ]] && CHROME="google-chrome"
OUT="${OUT:-docs/screenshots}"
BASE="${BASE:-http://localhost:3030}"

mkdir -p "$OUT"

# JS injection: replaces MACs with `AA:BB:CC:DD:EE:01..NN`, mangles hostnames.
# Saved to a tmp file because Chrome's --window-size + --evaluate flags don't
# accept multi-statement scripts reliably; we use a tiny user-script via
# --enable-features=DocumentPolicy works but simpler: navigate and inject via
# Puppeteer-style waiting using Chrome's --virtual-time-budget AFTER injection.
# We use the bookmarklet approach: hash fragment triggers a client-side mask.

MASK_HASH="#__mask__"

shoot() {
  local name="$1" path="$2"
  "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=1440,1100 --virtual-time-budget=8000 \
    --screenshot="$OUT/${name}.png" "$BASE${path}${MASK_HASH}" 2>/dev/null
  echo "  ✓ $OUT/${name}.png"
}

echo "Capturing screenshots from $BASE → $OUT/ (with mask)"
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
shoot setup /setup?force=1

echo "Done. Review images before committing."
