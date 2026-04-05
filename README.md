<p align="center">
  <h1 align="center">TeleClaude</h1>
  <p align="center">
    <strong>Claude Code lost its Telegram integration? We bring it back — on your own terms.</strong>
  </p>
  <p align="center">
    Route Telegram topics to isolated Claude Code sessions with persistent memory
  </p>
  <p align="center">
    <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun"></a>
    <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0+-3178c6?logo=typescript&logoColor=white" alt="TypeScript"></a>
    <a href="https://core.telegram.org/bots/api"><img src="https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?logo=telegram&logoColor=white" alt="Telegram Bot API"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  </p>
  <p align="center">
    <a href="README.ru.md">Русский</a>
  </p>
</p>

---

**TeleClaude** turns a Telegram supergroup with topics into a multi-project AI assistant. Each topic gets its own Claude Code process with an isolated working directory, persistent memory, and automatic context management.

A self-hosted replacement for [OpenClaw](https://openclaw.app)'s Telegram integration — but running Claude Code locally, with full filesystem access. Uses the same OAuth authentication as Claude Code on your machine, so if you have Claude Max (or any Claude subscription) — there are no extra API costs. You can also switch between Claude models (Opus, Sonnet, Haiku) or use local models through Claude Code's model routing.

## How It Works

```
Telegram Supergroup (forum mode)
│
├── Topic "Backend API"    →  Claude Code  →  ~/Projects/backend-api/
├── Topic "Landing Page"   →  Claude Code  →  ~/Projects/landing-page/
├── Topic "DevOps"         →  Claude Code  →  ~/Projects/devops/
└── Topic "New Feature"    →  auto-creates project directory
```

You write in a Telegram topic — Claude Code responds in the same topic, with full access to that project's files.

## Features

| Feature | Description |
|---------|-------------|
| **Topic Routing** | Each topic = isolated Claude Code process with its own `cwd` |
| **Persistent Memory** | Three-level memory: personality (SOUL.md) + shared (main-memory.md) + per-topic (topic-memory.md) |
| **Auto Project Creation** | New topics automatically get a project directory from templates |
| **Context Compaction** | Automatic context management — saves key decisions to memory when context grows |
| **Memory Deduplication** | Periodic cross-file dedup removes redundant information |
| **Voice Messages** | Transcription via local Whisper ASR server (optional) |
| **Session Continuity** | `--continue` flag preserves conversation across messages |
| **Process Management** | Configurable TTL, concurrent process limits, idle cleanup |
| **8 Bot Commands** | `/help` `/status` `/ttl` `/name` `/compact` `/reset` `/kill` `/memory` |
| **No API Key Needed** | Uses OAuth from your local Claude Code — works with any Claude subscription |
| **Model Switching** | Switch between Opus, Sonnet, Haiku, or use local models via Claude Code |

## Quick Start

**1. Install**

```bash
git clone https://github.com/devladpopov/teleclaude.git
cd teleclaude
bun install
```

**2. Configure**

```bash
cp .env.example .env                              # Add your Telegram bot token
cp config/settings.example.json config/settings.json  # Set your Telegram user ID
cp config/topics.example.json config/topics.json      # Auto-populated by the bot
```

**3. Set up templates**

```bash
cp templates/SOUL.example.md templates/SOUL.md
cp templates/main-memory.example.md templates/main-memory.md
# Edit both files — define your bot's personality and shared memory
```

**4. Start**

```bash
bun run start
```

Add the bot to a Telegram supergroup with topics enabled. Send a message in any topic — the bot will create a project directory and respond.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/help` | List all available commands |
| `/status` | Show active processes, TTL, and feature status |
| `/ttl N` | Set process idle timeout (1–1440 minutes) |
| `/name <name>` | Rename current topic (updates project mapping) |
| `/compact` | Force context compaction — save decisions to memory |
| `/reset` | Reset session — start fresh dialog with preserved memory |
| `/kill` | Kill current topic's Claude Code process |
| `/memory` | Show memory file count, size, and session stats |

## Architecture

```
┌──────────────────┐
│  Telegram Bot API │
└────────┬─────────┘
         │
┌────────▼─────────────────────────┐
│  Router (grammy)                 │
│  ├── Message routing by topic    │
│  ├── Command handling            │
│  ├── Memory context injection    │
│  ├── Context Compactor           │
│  ├── Memory Manager (dedup)      │
│  ├── Project Factory (templates) │
│  └── Whisper Client (optional)   │
└────────┬─────────────────────────┘
         │
┌────────▼─────────────────────────┐
│  Process Manager                 │
│  ├── Spawn per-message process   │
│  ├── stdin message passing       │
│  ├── Session continuity          │
│  ├── TTL & idle cleanup          │
│  └── Concurrency limits          │
└────────┬─────────────────────────┘
         │
┌────────▼─────────────────────────┐
│  Claude Code CLI                 │
│  One process per topic           │
│  Isolated working directory      │
│  Full filesystem access          │
└──────────────────────────────────┘
```

## Memory System

Each topic project maintains a three-level memory hierarchy:

```
project/
├── SOUL.md              # Bot personality and communication rules
├── main-memory.md       # Shared context across all projects (symlinked)
├── topic-memory.md      # Topic-specific memory (updated by Claude)
├── CLAUDE.md            # Project instructions for Claude Code
└── memory/
    ├── people/          # People and contacts
    ├── services/        # Infrastructure documentation
    ├── shared/          # Cross-project guides
    └── projects/        # Project-specific context
```

- **SOUL.md** — copied from template on project creation
- **main-memory.md** — symlinked so all projects share the same file
- **topic-memory.md** — evolves over time as Claude saves key decisions
- **memory/** — optional subdirectories for detailed knowledge base

## Configuration

### settings.json

| Key | Description | Default |
|-----|-------------|---------|
| `telegram.allowedUsers` | Telegram user IDs allowed to interact | `[]` |
| `processes.ttlMinutes` | Idle timeout before cleanup | `30` |
| `processes.maxConcurrent` | Max parallel Claude Code processes | `5` |
| `processes.claudePath` | Path to Claude Code CLI | `claude` |
| `compaction.enabled` | Auto context compaction | `true` |
| `memory.enabled` | Periodic memory revision | `true` |
| `memory.deduplication` | Cross-file deduplication | `true` |
| `whisper.enabled` | Voice transcription | `false` |
| `projectsRoot` | Root directory for projects | — |

## Requirements

- [Bun](https://bun.sh) 1.0+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (OAuth login)
- Any Claude subscription (Max, Pro, or Team) — or an API key
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Telegram supergroup with topics (forum mode) enabled
- (Optional) [Whisper ASR](https://github.com/ahmetoner/whisper-asr-webservice) on `localhost:9000`

> **How auth works:** TeleClaude doesn't need an API key by default. It spawns Claude Code CLI processes that use your existing OAuth session — the same way you use Claude Code in the terminal. If you're logged into Claude Code, TeleClaude just works.

## Security

- Only messages from `allowedUsers` are processed
- `ANTHROPIC_API_KEY` is stripped from child process environment
- Bot token, settings, and topic mappings are gitignored
- Each Claude Code process runs in an isolated project directory

## Comparison with OpenClaw

| | TeleClaude | OpenClaw |
|---|---|---|
| **Hosting** | Self-hosted (your machine) | Cloud service |
| **AI Backend** | Claude Code CLI (full filesystem access) | API-based |
| **Auth** | OAuth (your Claude subscription) | Managed |
| **Cost** | Free with any Claude subscription | Separate subscription |
| **Models** | Switch between Opus/Sonnet/Haiku + local models | Provider-dependent |
| **Memory** | File-based, persistent, cross-project | Built-in |
| **Customization** | Full control over prompts, memory, templates | Managed |
| **Topics** | Telegram supergroup topics | Telegram topics |
| **Voice** | Local Whisper (optional) | Built-in |

## Author

Built by [Vladislav Popov](https://github.com/devladpopov). I write about AI tools, automation, and development workflows on my Telegram channel — [@popovvii](https://t.me/popovvii).

## License

MIT
