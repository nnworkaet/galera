#!/usr/bin/env bash
set -euo pipefail

# ─── Galera installer ────────────────────────────────────────────────────────
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/nnworkaet/galera/main/install.sh)
#
# What it does:
#   1. Installs Node.js 22, Bun (system-wide), Claude Code CLI (system-wide)
#   2. Creates system user 'galera' to run the service (avoids root restriction)
#   3. Clones the repo to /opt/galera
#   4. Copies example configs and prompts for essential values
#   5. Creates a systemd service (runs as 'galera' user)
#   6. Prints instructions to authenticate Claude Code
# ─────────────────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/nnworkaet/galera.git"
INSTALL_DIR="/opt/galera"
PROJECTS_DIR="/opt/galera-projects"
SERVICE_NAME="galera"
GALERA_USER="galera"

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
apt-get install -y -qq curl git unzip openssh-client sudo

# ─── Node.js 22 ──────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -e 'console.log(process.version.split(".")[0].slice(1))')" -lt 22 ]]; then
  info "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
  success "Node.js $(node --version) installed"
else
  success "Node.js $(node --version) already installed"
fi

# ─── Bun (system-wide to /usr/local) ─────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null 2>&1
  success "Bun $(/usr/local/bin/bun --version) installed"
else
  success "Bun $(bun --version) already installed"
fi
BUN_PATH="$(command -v bun)"

# ─── Claude Code CLI (system-wide to /usr/local) ─────────────────────────────
if ! /usr/local/bin/claude --version &>/dev/null 2>&1 && ! /usr/bin/claude --version &>/dev/null 2>&1; then
  info "Installing Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code --prefix /usr/local >/dev/null 2>&1
  success "Claude Code CLI installed"
else
  success "Claude Code CLI already installed"
fi
CLAUDE_PATH="/usr/local/bin/claude"

# ─── System user 'galera' ────────────────────────────────────────────────────
# Claude Code refuses --dangerously-skip-permissions when running as root.
# We create a dedicated non-root user to run the service.
if ! id -u "$GALERA_USER" &>/dev/null; then
  info "Creating system user '$GALERA_USER'..."
  useradd -r -m -s /bin/bash "$GALERA_USER"
  success "User '$GALERA_USER' created"
else
  success "User '$GALERA_USER' already exists"
fi

# ─── Clone repo ──────────────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating existing installation at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --quiet
else
  info "Cloning Galera to $INSTALL_DIR..."
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

# Transfer ownership before installing deps
chown -R "$GALERA_USER:$GALERA_USER" "$INSTALL_DIR"

info "Installing dependencies..."
sudo -u "$GALERA_USER" "$BUN_PATH" install --cwd "$INSTALL_DIR" --quiet

# ─── Config setup ────────────────────────────────────────────────────────────
info "Setting up configuration..."

cd "$INSTALL_DIR"

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
chown -R "$GALERA_USER:$GALERA_USER" "$PROJECTS_DIR"

sed -i "s|/opt/galera-projects|$PROJECTS_DIR|g" config/settings.json
# Set claude path explicitly so it doesn't rely on PATH resolution
sed -i "s|\"claudePath\": \"claude\"|\"claudePath\": \"$CLAUDE_PATH\"|" config/settings.json

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
sed -i '0,/{/{s/{/{\n  "language": "'"$GALERA_LANG"'",/}' config/settings.json

# Fix ownership after config writes
chown -R "$GALERA_USER:$GALERA_USER" "$INSTALL_DIR"

# ─── systemd service ─────────────────────────────────────────────────────────
echo ""
info "Creating systemd service..."

cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=Galera Multi-Agent Bot
After=network.target

[Service]
User=$GALERA_USER
Group=$GALERA_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$BUN_PATH run src/index.ts
Restart=always
RestartSec=10
Environment=HOME=/home/$GALERA_USER
Environment=PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1

success "Systemd service created (runs as user '$GALERA_USER')"

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Galera installed!                           ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"

# ─── Claude auth ─────────────────────────────────────────────────────────────
echo ""
if [[ "$GALERA_LANG" == "en" ]]; then
  echo -e "${YELLOW}  Step 1 — Authenticate Claude Code${NC}"
  echo "  Run this command, open the URL it prints, log in:"
  echo ""
  echo "       sudo -u $GALERA_USER $CLAUDE_PATH login"
  echo ""
else
  echo -e "${YELLOW}  Шаг 1 — Авторизация Claude Code${NC}"
  echo "  Выполните команду, откройте ссылку из вывода, войдите в аккаунт:"
  echo ""
  echo "       sudo -u $GALERA_USER $CLAUDE_PATH login"
  echo ""
fi

# ─── Next steps ──────────────────────────────────────────────────────────────
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [[ "$GALERA_LANG" == "en" ]]; then
  echo -e "${YELLOW}  Step 2 — Start${NC}"
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo "  1. Add the CEO bot to your Telegram group as admin"
  echo "     (enable 'Manage Topics' permission)"
  echo "  2. Start Galera:"
  echo "       systemctl start $SERVICE_NAME"
  echo ""
  echo "  3. In the General topic, send /setup_general, then restart:"
  echo "       systemctl restart $SERVICE_NAME"
  echo ""
  echo "  4. Add agents:   /new_agent"
  echo "  5. View logs:    journalctl -u $SERVICE_NAME -f"
else
  echo -e "${YELLOW}  Шаг 2 — Запуск${NC}"
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo "  1. Добавьте CEO бота в Telegram группу как администратора"
  echo "     (включите разрешение 'Управление темами')"
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
