#!/usr/bin/env bash
# Tenda Monitor — automatic update from origin/main.
# Runs every 2 minutes via systemd timer.
# Safe: preserves .env, tenda.db*, logs/. Only pulls + builds + restarts when origin advanced.

set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/router_app}"
LOG="$APP_DIR/logs/auto-update.log"
STATIC_TMPDIR=""

mkdir -p "$APP_DIR/logs"
exec >> "$LOG" 2>&1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

cleanup_static_snapshot() {
  if [[ -n "${STATIC_TMPDIR:-}" && -d "$STATIC_TMPDIR" ]]; then
    rm -rf "$STATIC_TMPDIR"
  fi
}
trap cleanup_static_snapshot EXIT

cd "$APP_DIR"

# Bail if this is the admin/dev instance
if [[ -f "$APP_DIR/.admin" ]]; then
  # Silent: this is the dev box and we don't want to spam its log
  exit 0
fi

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

# Keep the previous Next.js static files around while building the new release.
# Open browser tabs can still request old hashed chunks during the restart
# window; preserving these files prevents transient ChunkLoadError/client-side
# exception screens when an auto-update lands.
if [[ -d "$APP_DIR/apps/web/.next/static" ]]; then
  STATIC_TMPDIR=$(mktemp -d)
  cp -a "$APP_DIR/apps/web/.next/static/." "$STATIC_TMPDIR/"
  log "snapshot: apps/web/.next/static"
fi

# Detect what kind of changes the new commits brought. Docs-only updates can
# skip pnpm install + build + service restart entirely — faster + zero downtime.
CHANGED_FILES=$(git diff --name-only "$LOCAL" "$REMOTE" 2>/dev/null || echo "")
NEEDS_BUILD=0
NEEDS_RESTART=0
for f in $CHANGED_FILES; do
  case "$f" in
    packages/*|apps/web/*|*.json|pnpm-lock.yaml) NEEDS_BUILD=1; NEEDS_RESTART=1 ;;
    deploy/*.service|deploy/*.timer)             NEEDS_RESTART=1 ;;
  esac
done

if [[ "$NEEDS_BUILD" == "1" ]]; then
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
  if [[ -n "$STATIC_TMPDIR" && -d "$STATIC_TMPDIR" && -d "$APP_DIR/apps/web/.next/static" ]]; then
    log "preserving previous Next static assets"
    cp -an "$STATIC_TMPDIR/." "$APP_DIR/apps/web/.next/static/" || true
    rm -rf "$STATIC_TMPDIR"
    STATIC_TMPDIR=""
  fi
else
  log "docs-only update — skipping build + restart"
fi

NEW=$(git rev-parse HEAD)

if [[ "$NEEDS_RESTART" == "1" ]]; then
  log "updated to $NEW; restarting services"

  # Reload + reinstall service unit files in case they changed
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SYSTEMD_DIR"
  for svc in tenda-poller.service tenda-web.service tenda-auto-update.service tenda-auto-update.timer; do
    if [[ -f "$APP_DIR/deploy/$svc" ]]; then
      install -m 0644 "$APP_DIR/deploy/$svc" "$SYSTEMD_DIR/$svc"
    fi
  done
  systemctl --user daemon-reload
  # Staggered restart so the web is rarely down. Poller first; wait for it
  # to come back up before bouncing the web.
  systemctl --user restart tenda-poller.service
  for i in 1 2 3 4 5 6; do
    if systemctl --user is-active --quiet tenda-poller.service; then break; fi
    sleep 1
  done
  systemctl --user restart tenda-web.service
else
  log "updated to $NEW (no restart needed)"
fi

log "update complete"
