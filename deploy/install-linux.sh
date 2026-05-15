#!/usr/bin/env bash
# Tenda Router Monitor — Linux installer (Ubuntu/Debian).
# Installs Node 22, pnpm, builds the project, installs user systemd services,
# and starts them. Re-runnable.

set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/router_app}"
NODE_MAJOR=22

step() { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
err()  { printf "\033[1;31mERROR: %s\033[0m\n" "$*" >&2; exit 1; }
ok()   { printf "  \033[0;32m✓\033[0m %s\n" "$*"; }

[[ -d "$APP_DIR" ]] || err "App directory not found: $APP_DIR"
cd "$APP_DIR"

step "1. Installing Node.js $NODE_MAJOR + build deps"
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v//; s/\..*//')" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash -
  sudo apt-get install -y nodejs build-essential python3
  ok "node $(node -v) installed"
else
  ok "node $(node -v) already present"
fi

if ! command -v pnpm >/dev/null; then
  sudo corepack enable
  corepack prepare pnpm@latest --activate
  ok "pnpm $(pnpm -v) activated"
else
  ok "pnpm $(pnpm -v) already present"
fi

step "2. Installing dependencies"
pnpm install --frozen-lockfile=false

step "3. Building all packages"
pnpm -r build

step "4. Preparing runtime files"
mkdir -p "$APP_DIR/logs"
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  ok "created .env from .env.example (onboarding via UI will populate it)"
else
  ok ".env already present — leaving as-is"
fi

step "5. Installing user systemd services"
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"
install -m 0644 "$APP_DIR/deploy/tenda-poller.service" "$SYSTEMD_DIR/tenda-poller.service"
install -m 0644 "$APP_DIR/deploy/tenda-web.service"    "$SYSTEMD_DIR/tenda-web.service"
systemctl --user daemon-reload
systemctl --user enable --now tenda-poller.service tenda-web.service
ok "services enabled (auto-start on login)"

step "6. Enabling lingering (services run without an active session)"
sudo loginctl enable-linger "$USER" || true

step "7. Status"
systemctl --user --no-pager --lines=0 status tenda-poller.service tenda-web.service || true

step "Done!"
cat <<EOF

Open in browser:    http://$(hostname -I | awk '{print $1}'):3030/
The first visit will prompt you to enter the router IP + password.

Logs:               $APP_DIR/logs/{poller,web}.{log,err}
Manage services:    systemctl --user {status|restart|stop} tenda-{poller,web}.service
EOF
