#!/usr/bin/env bash
set -euo pipefail

# ─── Galera installer ────────────────────────────────────────────────────────
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/nnworkaet/galera/main/install.sh)
#
# What it does:
#   1. Installs Node.js 22, Bun, Claude Code CLI
#   2. Clones the repo to /opt/galera
#   3. Copies example configs and prompts for essential values
#   4. Creates a systemd service for auto-start
#   5. Runs claude login at the very end
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
  success "Claude Code CLI installed"
else
  success "Claude Code CLI already installed"
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
sed -i "s|/opt/galera-projects|$PROJECTS_DIR|g" config/settings.json

# ─── Language ────────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  Language / Язык${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  1) Русский"
echo "  2) English"
echo ""
read -rp "  Choose / Выберите [1/2] (default: 1): " LANG_CHOICE

case "$LANG_CHOICE" in
  2) GALERA_LANG="en" ;;
  *) GALERA_LANG="ru" ;;
esac

# ─── Interactive config ───────────────────────────────────────────────────────
echo ""
if [[ "$GALERA_LANG" == "en" ]]; then
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}  Required configuration${NC}"
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  read -rp "  Your Telegram user ID (from @userinfobot): " TG_USER_ID
  read -rp "  CEO bot token (from @BotFather):           " CEO_TOKEN
else
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}  Настройка${NC}"
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  read -rp "  Ваш Telegram ID (узнать у @userinfobot):  " TG_USER_ID
  read -rp "  Токен CEO бота (от @BotFather):           " CEO_TOKEN
fi

# Write .env
cat > .env << EOF
TELEGRAM_CEO_TOKEN=$CEO_TOKEN
EOF

# Write user ID and language to settings.json
sed -i "s/123456789/$TG_USER_ID/" config/settings.json
# Insert language into settings.json (after first {)
sed -i '0,/{/{s/{/{\n  "language": "'"$GALERA_LANG"'",/}' config/settings.json

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

success "Systemd service created"

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Galera installed!                           ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"

# ─── Claude login check ──────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [[ "$GALERA_LANG" == "en" ]]; then
  echo -e "${YELLOW}  Claude Code authentication${NC}"
else
  echo -e "${YELLOW}  Авторизация Claude Code${NC}"
fi
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check if already authenticated (auth.json exists and non-empty)
AUTH_FILE="$HOME/.claude/auth.json"
if [[ -s "$AUTH_FILE" ]]; then
  success "Claude Code already authenticated — skipping login"
else
  if [[ "$GALERA_LANG" == "en" ]]; then
    warn "Claude Code is not authenticated yet."
    echo "  Run this command after the install completes:"
    echo ""
    echo "       claude login"
    echo ""
    echo "  It will open a browser URL for OAuth. After login, start Galera."
  else
    warn "Claude Code не авторизован."
    echo "  Выполните эту команду после установки:"
    echo ""
    echo "       claude login"
    echo ""
    echo "  Откроется ссылка для входа через браузер. После входа запустите Galera."
  fi
fi

# ─── Next steps ──────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [[ "$GALERA_LANG" == "en" ]]; then
  echo -e "${YELLOW}  Next steps${NC}"
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo "  1. Add the CEO bot to your Telegram group as admin"
  echo "  2. Start Galera:"
  echo "       systemctl start $SERVICE_NAME"
  echo ""
  echo "  3. In the General topic, send /setup_general, then restart:"
  echo "       systemctl restart $SERVICE_NAME"
  echo ""
  echo "  4. Add agents:   /new_agent"
  echo "  5. View logs:    journalctl -u $SERVICE_NAME -f"
else
  echo -e "${YELLOW}  Следующие шаги${NC}"
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo "  1. Добавьте CEO бота в Telegram группу как администратора"
  echo "  2. Запустите Galera:"
  echo "       systemctl start $SERVICE_NAME"
  echo ""
  echo "  3. В топике General отправьте /setup_general, затем перезапустите:"
  echo "       systemctl restart $SERVICE_NAME"
  echo ""
  echo "  4. Добавить агентов:  /new_agent"
  echo "  5. Логи:              journalctl -u $SERVICE_NAME -f"
fi
echo ""
