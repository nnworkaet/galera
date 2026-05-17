# Galera

**Multi-agent AI system in Telegram, powered by Claude Code.**

Galera runs a team of AI agents directly in your Telegram group. Each agent is a real Telegram bot with its own Claude Code process, persistent memory, and a dedicated topic in your forum group. They coordinate in a shared General topic — orchestrator delegates, specialists execute in parallel.

```
You → General topic → CEO (orchestrator) → CTO, CMO, DevOps, ... (parallel/sequential)
```

---

## Features

- **Multi-bot**: every agent is a separate Telegram bot (own token, own process)
- **Orchestrator pattern**: CEO analyses the task, delegates to specialists, collects results
- **Parallel & sequential execution**: same paragraph = parallel, blank line between = sequential
- **3-level memory**: session (`topic-memory.md`) → shared (`main-memory.md`) → long-term (`ltm/`)
- **LTM pre-retrieval**: relevant LTM sections auto-injected into every agent prompt
- **SSH / VPS access**: agents can execute commands on remote servers
- **Typing indicators**: each agent shows live typing while working
- **Auto-retry**: up to 2 retries with error context on failure
- **Live agent management**: add/remove agents without restart via `/new_agent`
- **Secrets manager**: store credentials in shared memory
- **Usage tracking**: daily/weekly message and token stats

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- [Claude Code CLI](https://docs.anthropic.com/claude-code) (authenticated via `claude login`)
- Telegram group in **Forum/Topics** mode
- One Telegram bot token per agent (via [@BotFather](https://t.me/BotFather))

---

## Quick Start (Linux / macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/nnworkaet/galera/main/install.sh | bash
```

The installer handles everything: Bun, repo clone, config setup, systemd service.

### Manual setup

```bash
# 1. Clone
git clone https://github.com/nnworkaet/galera.git && cd galera

# 2. Install dependencies
bun install

# 3. Copy config templates
cp .env.example .env
cp config/settings.example.json config/settings.json
cp config/agents.example.json config/agents.json

# 4. Fill in .env — add your bot tokens
nano .env

# 5. Edit settings.json — set your Telegram user ID and projectsRoot path
nano config/settings.json

# 6. Authenticate Claude Code
claude login

# 7. Start
bun start
```

---

## Configuration

### `.env`

```env
TELEGRAM_CEO_TOKEN=7123456789:AAF...   # CEO bot token from @BotFather
# More tokens are added automatically when you run /new_agent
```

### `config/settings.json`

| Field | Description |
|-------|-------------|
| `telegram.allowedUsers` | Array of Telegram user IDs allowed to interact |
| `projectsRoot` | Directory where agent memory is stored (e.g. `/opt/galera-projects`) |
| `processes.timeoutMinutes` | Max time per Claude task (default: 20) |
| `multiAgent.groupChatId` | Your Telegram group ID |
| `multiAgent.generalTopicId` | Topic ID of the General shared topic |

### `config/agents.json`

Created automatically via `/new_agent`. Contains one agent per entry with `id`, `name`, `tokenEnvKey`, `role`, `isOrchestrator`, `topicId`.

---

## First Run

1. Create a CEO bot via [@BotFather](https://t.me/BotFather), add it to your group as **admin**
2. Put the token in `.env` as `TELEGRAM_CEO_TOKEN`
3. Start: `bun start`
4. In the **General topic**, run `/setup_general` — saves the group/topic IDs
5. Restart: `bun start`
6. Add more agents anytime via `/new_agent` — no restart needed

---

## Commands (CEO bot)

### Agents
| Command | Description |
|---------|-------------|
| `/new_agent` | Add a new agent interactively |
| `/agents` | List all agents and status |
| `/kill_agent <id>` | Stop and remove an agent |

### Memory
| Command | Description |
|---------|-------------|
| `/memory` | Send all memory files as MD documents |
| `/recall <query>` | Search long-term memory (LTM) |
| `/ltm_list` | Show LTM index |
| `/ltm_show <file>` | Send a specific LTM file |
| `/compact` | Compress all agent session contexts |

### System
| Command | Description |
|---------|-------------|
| `/status` | Usage stats + memory sizes |
| `/secret_set <key> <value>` | Store a secret |
| `/secret_list` | List stored secret keys |
| `/secret_delete <key>` | Delete a secret |
| `/setup_general` | Configure current topic as General |
| `/help` | Full command reference |

---

## Memory Architecture

```
topic-memory.md          — per-agent session notes (private, not shared)
main-memory.md           — shared facts: servers, contacts, key decisions
ltm/
  _index.md              — keyword index (auto-maintained by agents)
  servers.md             — infrastructure docs
  projects.md            — project history
  ...                    — any domain file agents write to
```

Agents read `_index.md` before every task and load only relevant sections.

---

## Orchestrator Delegation Syntax

CEO delegates using `@Name:` mentions in its reply:

```
@CTO: build the landing page
@CMO: analyse SEO for the domain

@DevOps: deploy what CTO just built to production
```

- **Same paragraph** → parallel execution (both agents run simultaneously)
- **Blank line between** → sequential (second waits for first to finish)

---

## Running as a systemd Service

```bash
sudo tee /etc/systemd/system/galera.service > /dev/null << 'EOF'
[Unit]
Description=Galera Multi-Agent Bot
After=network.target

[Service]
WorkingDirectory=/opt/galera
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=10
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now galera
sudo journalctl -u galera -f
```

---

## Migrating to a New Server

Only these need to be copied — everything else regenerates:

```
.env
config/settings.json
config/agents.json
config/.secrets.json
<projectsRoot>/projects/_shared/main-memory.md
<projectsRoot>/projects/_shared/ltm/
<projectsRoot>/projects/<agent>/topic-memory.md   # for each agent
```

---

## License

MIT
