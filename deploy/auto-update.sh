#!/usr/bin/env bash
# Tenda Monitor — automatic update from origin/main.
# Runs every 2 minutes via systemd timer.
# Safe: preserves .env, tenda.db*, logs/. Only pulls + builds + restarts when origin advanced.

set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/router_app}"
LOG="$APP_DIR/logs/auto-update.log"

mkdir -p "$APP_DIR/logs"
exec >> "$LOG" 2>&1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

cd "$APP_DIR"

# Bail if not a git checkout
if [[ ! -d .git ]]; then
  log "not a git checkout, skipping"
  exit 0
fi

# Fetch latest from origin, quiet
if ! git fetch --quiet origin main 2>>"$LOG"; then
  log "fetch failed (network?); skipping this tick"
  exit 0
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [[ "$LOCAL" == "$REMOTE" ]]; then
  # Up to date — silent exit
  exit 0
fi

log "update available: $LOCAL → $REMOTE"

# Snapshot user-data files we must never lose
TMPDIR=$(mktemp -d)
for f in .env tenda.db tenda.db-shm tenda.db-wal; do
  [[ -f "$f" ]] && cp -a "$f" "$TMPDIR/" && log "snapshot: $f"
done

# Hard-reset to origin/main (any local edits would otherwise block pull)
# Anything sensitive (.env, *.db, logs/) is gitignored so reset doesn't touch it.
if ! git reset --hard origin/main >>"$LOG" 2>&1; then
  log "git reset failed"
  exit 1
fi

# Restore snapshots in case reset somehow nuked them (paranoid; gitignore should protect)
for f in .env tenda.db tenda.db-shm tenda.db-wal; do
  if [[ -f "$TMPDIR/$f" && ! -f "$APP_DIR/$f" ]]; then
    cp -a "$TMPDIR/$f" "$APP_DIR/$f"
    log "restored: $f"
  fi
done
rm -rf "$TMPDIR"

log "running pnpm install"
if ! pnpm install --frozen-lockfile=false >>"$LOG" 2>&1; then
  log "pnpm install failed"
  exit 1
fi

log "running pnpm build"
if ! pnpm -r build >>"$LOG" 2>&1; then
  log "pnpm build failed"
  exit 1
fi

NEW=$(git rev-parse HEAD)
log "updated to $NEW; restarting services"

# Reload + restart via user systemd (this script runs as the same user)
systemctl --user daemon-reload || true
# Reinstall service units in case they changed
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"
for svc in tenda-poller.service tenda-web.service tenda-auto-update.service tenda-auto-update.timer; do
  if [[ -f "$APP_DIR/deploy/$svc" ]]; then
    install -m 0644 "$APP_DIR/deploy/$svc" "$SYSTEMD_DIR/$svc"
  fi
done
systemctl --user daemon-reload
systemctl --user restart tenda-poller.service tenda-web.service

log "update complete"
