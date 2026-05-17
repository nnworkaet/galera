#!/usr/bin/env bash
set -euo pipefail

# ─── Galera installer ────────────────────────────────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/galera/main/install.sh | bash
#
# What it does:
#   1. Installs Node.js 22, Bun
#   2. Clones the repo to /opt/galera
#   3. Installs Claude Code CLI
#   4. Copies example configs and prompts for essential values
#   5. Creates a systemd service for auto-start
# ─────────────────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/nnworkaet/galera.git"
INSTALL_DIR="/opt/galera"
PROJECTS_DIR="/opt/galera-projects"
SERVICE_NAME="galera"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[galera]${NC} $*"; }
success() { echo -e "${GREEN}[galera]${NC} $*"; }
warn()    { echo -e "${YELLOW}[galera]${NC} $*"; }
error()   { echo -e "${RED}[galera] ERROR:${NC} $*"; exit 1; }

# ─── Root check ──────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "Run as root: sudo bash install.sh"
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║       Galera — Multi-Agent AI        ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ─── System packages ─────────────────────────────────────────────────────────
info "Updating apt..."
apt-get update -qq

info "Installing prerequisites..."
apt-get install -y -qq curl git unzip openssh-client

# ─── Node.js 22 ──────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -e 'console.log(process.version.split(".")[0].slice(1))')" -lt 22 ]]; then
  info "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
  success "Node.js $(node --version) installed"
else
  success "Node.js $(node --version) already installed"
fi

# ─── Bun ─────────────────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  export PATH="$HOME/.bun/bin:$PATH"
  success "Bun $(bun --version) installed"
else
  export PATH="$HOME/.bun/bin:$PATH"
  success "Bun $(bun --version) already installed"
fi

# ─── Claude Code CLI ─────────────────────────────────────────────────────────
if ! command -v claude &>/dev/null; then
  info "Installing Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
  success "Claude Code installed"
else
  success "Claude Code already installed"
fi

# ─── Clone repo ──────────────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating existing installation at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --quiet
else
  info "Cloning Galera to $INSTALL_DIR..."
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

info "Installing dependencies..."
"$HOME/.bun/bin/bun" install --quiet

# ─── Config setup ────────────────────────────────────────────────────────────
echo ""
info "Setting up configuration..."

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

if [[ ! -f config/settings.json ]]; then
  cp config/settings.example.json config/settings.json
fi

if [[ ! -f config/agents.json ]]; then
  cp config/agents.example.json config/agents.json
fi

mkdir -p "$PROJECTS_DIR/projects/_shared/ltm"

# Update projectsRoot in settings.json
sed -i "s|/opt/galera-projects|$PROJECTS_DIR|g" config/settings.json

# ─── Interactive config ───────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  Required configuration${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

read -rp "  Your Telegram user ID (from @userinfobot): " TG_USER_ID
read -rp "  CEO bot token (from @BotFather):           " CEO_TOKEN

# Write .env
cat > .env << EOF
TELEGRAM_CEO_TOKEN=$CEO_TOKEN
EOF

# Write user ID to settings.json
sed -i "s/123456789/$TG_USER_ID/g" config/settings.json

echo ""
warn "You can add more agents later via /new_agent in Telegram."

# ─── Claude login ────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  Claude Code authentication${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
info "Starting claude login (a URL will appear — open it in your browser)..."
echo ""
claude login || warn "Login failed or skipped. Run 'claude login' manually before starting."

# ─── systemd service ─────────────────────────────────────────────────────────
echo ""
info "Creating systemd service..."

BUN_PATH="$(command -v bun || echo "$HOME/.bun/bin/bun")"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=Galera Multi-Agent Bot
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=$BUN_PATH run src/index.ts
Restart=always
RestartSec=10
Environment=HOME=$HOME
Environment=PATH=$HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Galera installed successfully!              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Add your CEO bot to the Telegram group as admin"
echo "  2. Start Galera:"
echo "       systemctl start $SERVICE_NAME"
echo ""
echo "  3. In Telegram General topic, send:"
echo "       /setup_general"
echo "     Then restart:"
echo "       systemctl restart $SERVICE_NAME"
echo ""
echo "  4. Add more agents:"
echo "       /new_agent"
echo ""
echo "  Logs:"
echo "       journalctl -u $SERVICE_NAME -f"
echo ""
echo "  Config files:"
echo "       $INSTALL_DIR/.env"
echo "       $INSTALL_DIR/config/settings.json"
echo ""
