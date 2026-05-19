import { Bot, type Context } from "grammy";
import { mkdirSync, existsSync, writeFileSync, readFileSync, symlinkSync, copyFileSync } from "fs";
import { resolve, join } from "path";
import { ProcessManager } from "../process-manager";
import { ContextCompactor } from "../context-compactor";
import type { AgentDefinition } from "./AgentRegistry";
import type { Settings } from "../config";

export class AgentProcess {
  readonly bot: Bot;
  readonly config: AgentDefinition; // mutable fields (topicId) updated in place
  readonly projectPath: string;

  pm: ProcessManager;
  private compactor: ContextCompactor;
  private settings: Settings;
  private _username = "";
  private _chatId = 0;

  // Handlers registered by SharedChatManager / AgentFactory
  onGeneralMessage?: (ctx: Context, text: string, threadId: number) => Promise<void>;
  onPrivateTopicMessage?: (ctx: Context, text: string, topicKey: string, threadId?: number) => Promise<void>;

  constructor(config: AgentDefinition, settings: Settings) {
    this.config = config;
    this.settings = settings;

    const token = process.env[config.tokenEnvKey];
    if (!token) throw new Error(`Env var ${config.tokenEnvKey} not set for agent "${config.id}"`);

    this.bot = new Bot(token);
    this.pm = new ProcessManager(settings);
    this.compactor = new ContextCompactor(settings);
    this.pm.setCleanupCallback((key) => this.compactor.resetCounter(key));

    this.projectPath = resolve(settings.projectsRoot, config.projectDir);
    this.ensureProjectDir();
  }

  async init(): Promise<void> {
    const me = await this.bot.api.getMe();
    this._username = me.username ?? this.config.id;
    console.log(`[AgentProcess] ${this.config.name} → @${this._username}`);
  }

  get username(): string {
    return this._username;
  }

  get groupChatId(): number {
    return this._chatId;
  }

  // Run Claude Code for a given prompt; returns output text
  async runClaude(prompt: string, topicKey: string): Promise<string> {
    return this.pm.sendMessage(topicKey, this.projectPath, prompt);
  }

  // Send a message to a Telegram topic (chunked)
  async sendToTopic(chatId: number, threadId: number | undefined, text: string): Promise<void> {
    const MAX = 4000;
    let remaining = text;
    while (remaining.length > 0) {
      let chunk: string;
      if (remaining.length <= MAX) {
        chunk = remaining;
        remaining = "";
      } else {
        let split = remaining.lastIndexOf("\n", MAX);
        if (split < MAX * 0.5) split = remaining.lastIndexOf(" ", MAX);
        if (split < MAX * 0.5) split = MAX;
        chunk = remaining.slice(0, split);
        remaining = remaining.slice(split).trimStart();
      }
      try {
        await this.bot.api.sendMessage(chatId, chunk, { message_thread_id: threadId, parse_mode: "Markdown" });
      } catch {
        await this.bot.api.sendMessage(chatId, chunk, { message_thread_id: threadId });
      }
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.bot.api.deleteMessage(chatId, messageId);
    } catch {}
  }

  async createTopic(chatId: number, name: string): Promise<number | null> {
    try {
      const result = await this.bot.api.raw.createForumTopic({ chat_id: chatId, name });
      return (result as any).message_thread_id ?? null;
    } catch (e) {
      console.error(`[AgentProcess] createTopic failed:`, e);
      return null;
    }
  }

  setupHandlers(
    settings: Settings,
    allowedUsers: number[],
    generalTopicId: number | null,
    groupChatId: number
  ): void {
    this._chatId = groupChatId;

    this.bot.on("message", async (ctx) => {
      try {
        await this.handleMessage(ctx, allowedUsers, generalTopicId, groupChatId);
      } catch (err) {
        console.error(`[AgentProcess:${this.config.id}] Error:`, err);
      }
    });

    this.bot.on("my_chat_member", async (ctx) => {
      const update = ctx.myChatMember;
      if (!update) return;
      const chat = update.chat;
      const status = update.new_chat_member.status;
      if ((chat.type === "supergroup" || chat.type === "group") &&
          (status === "administrator" || status === "member")) {
        this._chatId = chat.id;
        console.log(`[AgentProcess:${this.config.id}] Added to group ${chat.id}`);
      }
    });
  }

  private async handleMessage(
    ctx: Context,
    allowedUsers: number[],
    generalTopicId: number | null,
    groupChatId: number
  ): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    const senderId = msg.from?.id ?? 0;
    if (!allowedUsers.includes(senderId)) return;

    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const text = (msg.text || msg.caption || "").trim();
    if (!text) return;

    // Route General topic to SharedChatManager handler
    if (generalTopicId && threadId === generalTopicId && chatId === groupChatId) {
      if (this.onGeneralMessage) {
        await this.onGeneralMessage(ctx, text, threadId);
      }
      return;
    }

    // Route personal topic to per-agent handler
    if (this.onPrivateTopicMessage) {
      const topicKey = `${chatId}:${threadId ?? "general"}`;
      await this.onPrivateTopicMessage(ctx, text, topicKey, threadId);
    }
  }

  async startBot(): Promise<void> {
    await this.bot.start({
      onStart: (info) => console.log(`[AgentProcess] @${info.username} started`),
    });
  }

  stopBot(): void {
    this.pm.shutdown();
    this.bot.stop();
  }

  private ensureProjectDir(): void {
    mkdirSync(this.projectPath, { recursive: true });

    // CLAUDE.md — always overwrite (config may have changed)
    const claudePath = join(this.projectPath, "CLAUDE.md");
    writeFileSync(claudePath, this.buildClaudeMd(), "utf-8");

    // SOUL.md — write if missing
    const soulPath = join(this.projectPath, "SOUL.md");
    if (!existsSync(soulPath)) {
      writeFileSync(soulPath, this.buildDefaultSoul(), "utf-8");
    }

    // topic-memory.md — preserve
    const memPath = join(this.projectPath, "topic-memory.md");
    if (!existsSync(memPath)) {
      writeFileSync(memPath, `# ${this.config.name} Memory\n\nAgent memory created: ${new Date().toISOString()}\n`, "utf-8");
    }

    // main-memory.md — symlink to _shared, fallback copy
    const sharedMemory = resolve(this.settings.projectsRoot, "projects/_shared/main-memory.md");
    const localMemory = join(this.projectPath, "main-memory.md");
    if (!existsSync(localMemory)) {
      if (existsSync(sharedMemory)) {
        try {
          symlinkSync(sharedMemory, localMemory);
        } catch {
          copyFileSync(sharedMemory, localMemory);
        }
      }
    }

    // ltm/ — junction/symlink to _shared/ltm/, fallback real directory
    const sharedLtm = resolve(this.settings.projectsRoot, "projects/_shared/ltm");
    const localLtm = join(this.projectPath, "ltm");
    mkdirSync(sharedLtm, { recursive: true });
    if (!existsSync(localLtm)) {
      try {
        symlinkSync(sharedLtm, localLtm, "junction");
      } catch {
        mkdirSync(localLtm, { recursive: true });
        writeFileSync(
          join(localLtm, "_redirect.md"),
          `# LTM Redirect\n\nShared LTM is located at:\n\`${sharedLtm}\`\n\nThis directory is a local cache. Prefer reading from the shared location.\n`,
          "utf-8"
        );
      }
    }
  }

  private buildClaudeMd(): string {
    const lines = [
      `# ${this.config.name} — Agent Instructions`,
      "",
      "## Role",
      `You are the ${this.config.name}, an AI agent in a multi-agent team.`,
      `Role: ${this.config.role}`,
      "",
      "## Memory Files",
      "- SOUL.md — your personality and rules (read at start)",
      "- topic-memory.md — your personal memory and notes",
      "- main-memory.md — shared knowledge (servers, contacts, global facts)",
      "- ltm/ — long-term memory files (see Long-Term Memory section below)",
      "",
      "## Long-Term Memory",
      "Location: ./ltm/  (symlinked to shared LTM — readable by all agents)",
      "",
      "BEFORE every task:",
      "1. Read ./ltm/_index.md (small, always do this first)",
      "2. Match keywords from your task with the Keywords column",
      "3. Read only relevant files/sections (NOT all files at once)",
      "",
      "AFTER completing significant tasks:",
      "- If you discovered new infrastructure facts, configs, or important decisions:",
      "  - Append to the relevant file in ./ltm/ using ## #section-name format",
      "  - Update ./ltm/_index.md with the new entry",
      "- Use main-memory.md for current active tasks and short-term notes",
      "- Use topic-memory.md for session context",
      "",
      "NEVER:",
      "- Load all LTM files at once",
      "- Store secret values, passwords, or tokens in LTM files",
      "- Duplicate information already in main-memory.md",
      "",
      "## Chat Rules (MANDATORY)",
      "1. You are in a shared Telegram chat with other agents.",
      "2. Only respond if: (a) directly @mentioned, or (b) orchestrator delegated the task to you.",
      "3. Never initiate conversation without being asked.",
      "4. After completing your task, write [DONE] at the end of your message.",
      "5. If you need another agent, notify the orchestrator only.",
      "6. Maximum 3 messages per task before requesting user clarification.",
      "7. NEVER start your message with your own name or role (e.g. do NOT write 'CEO:', 'CTO:', your name). Your Telegram username already identifies you.",
      "",
      "## Security Rules",
      "- Never write secret values (tokens, passwords, keys) to memory files.",
      "- Never output credential values in chat messages.",
      "",
    ];

    if (this.config.vps?.length) {
      lines.push("## SSH / VPS Access");
      for (const vps of this.config.vps) {
        lines.push(`- ${vps.alias} (${vps.host}): ssh -i ${vps.keyPath} ${vps.user}@${vps.host} "<command>"`);
      }
      lines.push("- Always use non-interactive SSH (no TTY).");
      lines.push("- Log all executed commands to memory files.");
      lines.push("");
    }

    if (this.config.isOrchestrator) {
      lines.push("## Orchestrator Rules");
      lines.push("- You coordinate the team. Analyze tasks and delegate to specialists.");
      lines.push("- To delegate use: @AgentName: <task description>");
      lines.push("- PARALLEL (tasks are independent — put in same paragraph, no blank line between):");
      lines.push("    @CTO: build the page");
      lines.push("    @CMO: analyze SEO");
      lines.push("- SEQUENTIAL (task B needs result of task A — separate with a blank line):");
      lines.push("    @CTO: build the page and return the URL");
      lines.push("");
      lines.push("    @DevOps: deploy what CTO built at <URL>");
      lines.push("- Choose parallel when tasks are independent. Choose sequential when one depends on another's output.");
      lines.push("- You may handle simple tasks yourself without delegation.");
      lines.push("- Always confirm task completion to the user.");
      lines.push("");
    }

    return lines.join("\n");
  }

  private buildDefaultSoul(): string {
    if (this.config.isOrchestrator) {
      return [
        `# ${this.config.name}`,
        "",
        "You are the CEO and orchestrator of a multi-agent AI team.",
        "You coordinate specialists to accomplish user goals efficiently.",
        "Communication style: clear, decisive, professional.",
        "Always confirm decisions and status updates to the user.",
      ].join("\n");
    }
    return [
      `# ${this.config.name}`,
      "",
      `You are the ${this.config.name} agent, specialist in ${this.config.role}.`,
      "Complete delegated tasks efficiently and report results clearly.",
    ].join("\n");
  }
}
