import { Bot, type Context } from "grammy";
import { existsSync, writeFileSync, readFileSync, mkdirSync, copyFileSync } from "fs";
import { resolve, join } from "path";
import { type Settings, loadTopics, saveTopics, type TopicsConfig, type TopicMapping } from "./config";
import { ProcessManager } from "./process-manager";
import { ProjectFactory } from "./project-factory";
import { WhisperClient } from "./whisper";
import { ContextCompactor } from "./context-compactor";
import { MemoryManager } from "./memory-manager";

export class Router {
  private bot: Bot;
  private settings: Settings;
  private topics: TopicsConfig;
  private processManager: ProcessManager;
  private projectFactory: ProjectFactory;
  private whisper: WhisperClient;
  private compactor: ContextCompactor;
  private memoryManager: MemoryManager;
  // Dynamic topic name cache: "chatId:threadId" → name
  private topicNameCache = new Map<string, string>();

  constructor(botToken: string, settings: Settings) {
    this.bot = new Bot(botToken);
    this.settings = settings;
    this.topics = loadTopics();
    this.processManager = new ProcessManager(settings);
    this.projectFactory = new ProjectFactory(settings);
    this.whisper = new WhisperClient(settings);
    this.compactor = new ContextCompactor(settings);
    this.memoryManager = new MemoryManager(settings);

    // Reset compaction counters when a process is cleaned up (TTL expired)
    this.processManager.setCleanupCallback((topicKey) => {
      this.compactor.resetCounter(topicKey);
    });
  }

  async start(): Promise<void> {
    // Auto-register when bot is added to a group
    this.bot.on("my_chat_member", async (ctx) => {
      const update = ctx.myChatMember;
      if (!update) return;
      const chat = update.chat;
      const newStatus = update.new_chat_member.status;

      if ((chat.type === "supergroup" || chat.type === "group") && (newStatus === "administrator" || newStatus === "member")) {
        const chatId = chat.id.toString();
        const chatTitle = chat.title || `group-${chatId}`;
        if (!this.topics.groups[chatId]) {
          this.topics.groups[chatId] = { name: chatTitle, enabled: true };
          saveTopics(this.topics);
          console.log(`[Router] Bot added to group: ${chatTitle} (${chatId})`);
        }
      }
    });

    // Capture topic names from forum events
    this.bot.on("message:forum_topic_created", async (ctx) => {
      const msg = ctx.message;
      if (!msg.forum_topic_created) return;
      const chatId = msg.chat.id.toString();
      const threadId = msg.message_thread_id;
      if (threadId) {
        const name = msg.forum_topic_created.name;
        this.cacheTopicName(chatId, threadId, name);
        console.log(`[Router] Topic created: ${name} (thread ${threadId})`);
      }
    });

    this.bot.on("message:forum_topic_edited", async (ctx) => {
      const msg = ctx.message;
      if (!msg.forum_topic_edited?.name) return;
      const chatId = msg.chat.id.toString();
      const threadId = msg.message_thread_id;
      if (threadId) {
        const name = msg.forum_topic_edited.name;
        this.cacheTopicName(chatId, threadId, name);
        // Update existing topic mapping name if exists
        const topicKey = this.buildTopicKey(chatId, threadId);
        if (this.topics.topics[topicKey]) {
          this.topics.topics[topicKey].name = name;
          saveTopics(this.topics);
        }
        console.log(`[Router] Topic renamed: ${name} (thread ${threadId})`);
      }
    });

    // Handle all messages
    this.bot.on("message", async (ctx) => {
      try {
        await this.handleMessage(ctx);
      } catch (err) {
        console.error("[Router] Error handling message:", err);
        try {
          await ctx.reply(`Ошибка: ${(err as Error).message}`, {
            message_thread_id: ctx.message?.message_thread_id,
          });
        } catch {}
      }
    });

    // Graceful shutdown
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());

    // Start memory manager
    this.memoryManager.start();

    console.log("[Router] Starting bot...");
    await this.bot.start({
      onStart: (info) => {
        console.log(`[Router] Bot started: @${info.username}`);
      },
    });
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    // Security: only process messages from allowed users
    const senderId = msg.from?.id ?? 0;
    if (!this.settings.telegram.allowedUsers.includes(senderId)) {
      console.log(`[Router] Ignored message from unauthorized user ${senderId}`);
      return;
    }

    const chatId = msg.chat.id.toString();
    const threadId = msg.message_thread_id;

    // Private messages - route as chatId:general (same pipeline as group topics)

    // Auto-register group if not known yet (skip for private chats)
    if (msg.chat.type !== "private" && !this.topics.groups[chatId]) {
      const chatTitle = msg.chat.title || `group-${chatId}`;
      this.topics.groups[chatId] = { name: chatTitle, enabled: true };
      saveTopics(this.topics);
      console.log(`[Router] Auto-registered new group: ${chatTitle} (${chatId})`);
    }
    const groupConfig = msg.chat.type !== "private" ? this.topics.groups[chatId] : { enabled: true };
    if (!groupConfig.enabled) {
      console.log(`[Router] Group ${chatId} disabled, ignoring`);
      return;
    }
    // Acknowledge receipt with eyes reaction
    try { await ctx.react("👀"); } catch {}

    // Get message text (or transcribe voice)
    let messageText = msg.text || msg.caption || "";

    // Handle voice messages
    if (msg.voice || msg.audio) {
      const fileId = msg.voice?.file_id || msg.audio?.file_id;
      if (fileId) {
        await ctx.react("👀");
        const file = await ctx.api.getFile(fileId);
        const filePath = resolve(this.settings.projectsRoot, ".tmp", `voice-${Date.now()}.oga`);

        // Download file
        const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());

        const tmpDir = resolve(this.settings.projectsRoot, ".tmp");
        if (!existsSync(tmpDir)) {
          const { mkdirSync } = await import("fs");
          mkdirSync(tmpDir, { recursive: true });
        }
        writeFileSync(filePath, buffer);

        // Transcribe
        const transcript = await this.whisper.transcribe(filePath);
        if (transcript) {
          messageText = transcript;
          // Send transcription as a reply
          await ctx.reply(`📝 Расшифровка:\n${transcript}`, {
            message_thread_id: threadId,
            reply_to_message_id: msg.message_id,
          });
        } else {
          await ctx.reply("Не удалось распознать голосовое сообщение.", {
            message_thread_id: threadId,
          });
          return;
        }
      }
    }

    if (!messageText) return;

    // Remove bot mention from text
    const botUsername = this.bot.botInfo?.username;
    if (botUsername) {
      messageText = messageText.replace(new RegExp(`@${botUsername}\\s*`, "gi"), "").trim();
    }

    if (!messageText) return;

    // Handle bot commands before routing to Claude
    if (messageText.startsWith("/")) {
      const handled = await this.handleCommand(ctx, messageText, threadId);
      if (handled) return;
    }

    // Route by topic
    const topicKey = this.buildTopicKey(chatId, threadId);
    console.log(`[Router] Message in topic ${topicKey}: ${messageText.slice(0, 80)}...`);

    // Show typing
    await ctx.api.sendChatAction(msg.chat.id, "typing", {
      message_thread_id: threadId,
    });

    // Get or create project for this topic
    const mapping = await this.resolveTopicMapping(topicKey, chatId, threadId, messageText, ctx);

    // Inject memory context into first message of session
    let fullMessage = messageText;
    if (!this.processManager.getSessionId(topicKey)) {
      const memoryContext = this.loadMemoryContext(mapping.project, mapping.name);
      fullMessage = `${memoryContext}\n\n---\nСообщение от пользователя:\n${messageText}`;
    }

    // Add compaction prompt if context is growing large
    const compactionPrompt = this.compactor.trackMessage(topicKey, fullMessage.length);
    if (compactionPrompt) {
      fullMessage = compactionPrompt + fullMessage;
      console.log(`[Router] Compaction triggered for ${topicKey} (${this.compactor.getMessageCount(topicKey)} msgs, ${this.compactor.getCharCount(topicKey)} chars)`);
    }

    // Send to Claude Code
    const sessionId = this.processManager.getSessionId(topicKey) || mapping.sessionId;
    const response = await this.processManager.sendMessage(
      topicKey,
      mapping.project,
      fullMessage,
      sessionId
    );

    // Update session ID
    const newSessionId = this.processManager.getSessionId(topicKey);
    if (newSessionId && newSessionId !== mapping.sessionId) {
      mapping.sessionId = newSessionId;
      this.topics.topics[topicKey] = mapping;
      saveTopics(this.topics);
    }

    // Send response back to the same topic
    if (response) {
      await this.sendLongMessage(ctx, response, threadId);
    } else {
      await ctx.reply("Claude не вернул ответ.", { message_thread_id: threadId });
    }
  }

  private async resolveTopicMapping(
    topicKey: string,
    chatId: string,
    threadId: number | undefined,
    firstMessage: string,
    ctx: Context
  ): Promise<TopicMapping> {
    const memoryDir = resolve(__dirname, "..", "templates", "openclaw-memory");

    // Check existing mapping
    if (this.topics.topics[topicKey]) {
      const mapping = this.topics.topics[topicKey];

      // If migrated from OpenClaw but no real project dir yet — create one
      if ((mapping as any).migratedFromOpenClaw && !existsSync(resolve(this.settings.projectsRoot, mapping.name))) {
        const realProject = this.projectFactory.createProject(
          mapping.name, chatId, String(threadId || "general"), firstMessage
        );
        mapping.project = realProject.project;

        // Copy topic-specific memory from OpenClaw export
        const topicMemFile = (mapping as any).topicMemory as string | undefined;
        if (topicMemFile) {
          const src = resolve(memoryDir, topicMemFile);
          if (existsSync(src)) {
            copyFileSync(src, join(realProject.project, "topic-memory.md"));
            console.log(`[Router] Copied topic memory: ${topicMemFile}`);
          }
        }

        // Copy shared memory files (people, services, shared, projects)
        this.copySharedMemory(realProject.project, memoryDir);

        delete (mapping as any).migratedFromOpenClaw;
        delete (mapping as any).topicMemory;
        this.topics.topics[topicKey] = mapping;
        saveTopics(this.topics);

        await ctx.reply(`📂 Проект инициализирован: ${mapping.name}\n📁 ${mapping.project}`, {
          message_thread_id: threadId,
        });
        return mapping;
      }

      // Verify project still exists
      if (existsSync(mapping.project)) {
        return mapping;
      }
      console.log(`[Router] Project path missing, recreating: ${mapping.project}`);
    }

    // Get topic name — try multiple methods
    let topicName = "general";
    const chatTitle = ctx.message?.chat.title || "";
    if (threadId) {
      // Method 1: forum_topic_created in reply_to_message (most reliable)
      if (ctx.message?.reply_to_message?.forum_topic_created) {
        topicName = ctx.message.reply_to_message.forum_topic_created.name;
        this.cacheTopicName(chatId, threadId, topicName);
      } else {
        // Method 2: dynamic cache (populated from forum events)
        const cacheKey = `${chatId}:${threadId}`;
        const cachedName = this.topicNameCache.get(cacheKey);
        if (cachedName) {
          topicName = cachedName;
        } else {
          // Method 3: check topics.json for previously saved name
          const knownName = this.getKnownTopicName(chatId, threadId);
          if (knownName) {
            topicName = knownName;
            this.topicNameCache.set(cacheKey, knownName);
          } else {
            // Method 4: fallback to group-topic-id
            topicName = `${chatTitle}-topic-${threadId}`;
          }
        }
      }
    } else {
      topicName = chatTitle ? `${chatTitle}-general` : "general";
    }

    // Create new project
    const mapping = this.projectFactory.createProject(topicName, chatId, String(threadId || "general"), firstMessage);

    // Check if there's an OpenClaw topic memory for this thread
    if (threadId) {
      const topicMemFile = `topics/topic-${threadId}.md`;
      const src = resolve(memoryDir, topicMemFile);
      if (existsSync(src)) {
        copyFileSync(src, join(mapping.project, "topic-memory.md"));
        console.log(`[Router] Found and copied OpenClaw memory for topic ${threadId}`);
      }
    }

    // Copy shared memory
    this.copySharedMemory(mapping.project, memoryDir);

    this.topics.topics[topicKey] = mapping;
    saveTopics(this.topics);

    await ctx.reply(`🆕 Проект создан: ${mapping.name}\n📁 ${mapping.project}`, {
      message_thread_id: threadId,
    });

    return mapping;
  }

  private copySharedMemory(projectPath: string, memoryDir: string): void {
    // Copy shared memory subdirectories into the project
    const sharedDirs = ["people", "services", "shared", "projects"];
    for (const dir of sharedDirs) {
      const srcDir = resolve(memoryDir, dir);
      if (!existsSync(srcDir)) continue;
      const dstDir = join(projectPath, "memory", dir);
      mkdirSync(dstDir, { recursive: true });

      // Copy all .md files from srcDir
      try {
        const files = require("fs").readdirSync(srcDir) as string[];
        for (const file of files) {
          if (file.endsWith(".md")) {
            copyFileSync(join(srcDir, file), join(dstDir, file));
          }
        }
      } catch {}
    }
    console.log(`[Router] Shared memory copied to ${projectPath}`);
  }

  private loadMemoryContext(projectPath: string, projectName: string): string {
    const parts: string[] = [];
    parts.push(`[СИСТЕМНЫЙ КОНТЕКСТ — проект: "${projectName}"]`);

    // Load SOUL.md
    const soulPath = join(projectPath, "SOUL.md");
    if (existsSync(soulPath)) {
      const content = readFileSync(soulPath, "utf-8");
      parts.push(`\n--- SOUL.md ---\n${content}`);
    }

    // Load topic-memory.md
    const topicMemPath = join(projectPath, "topic-memory.md");
    if (existsSync(topicMemPath)) {
      const content = readFileSync(topicMemPath, "utf-8");
      parts.push(`\n--- topic-memory.md (память проекта) ---\n${content}`);
    }

    // Load main-memory.md (truncated to avoid token overflow)
    const mainMemPath = join(projectPath, "main-memory.md");
    if (existsSync(mainMemPath)) {
      let content = readFileSync(mainMemPath, "utf-8");
      if (content.length > 3000) content = content.slice(0, 3000) + "\n...(обрезано)";
      parts.push(`\n--- main-memory.md (общая память) ---\n${content}`);
    }

    parts.push(`\n--- Конец контекста. Папка memory/ содержит дополнительные файлы (people/, services/, shared/, projects/). Читай их при необходимости. ---`);

    return parts.join("\n");
  }

  /**
   * Try to get topic name from existing topics.json mappings (by threadId).
   * Replaces the old hardcoded TOPIC_NAMES map — names are now persisted in topics.json.
   */
  private getKnownTopicName(chatId: string, threadId: number): string | null {
    // Search topics.json for any mapping with this chatId:threadId
    const topicKey = `${chatId}:${threadId}`;
    const existing = this.topics.topics[topicKey];
    if (existing?.name && !existing.name.includes("-topic-")) {
      return existing.name;
    }
    return null;
  }

  private buildTopicKey(chatId: string, threadId?: number): string {
    if (threadId) {
      return `${chatId}:${threadId}`;
    }
    return `${chatId}:general`;
  }

  /**
   * Split long messages (Telegram limit: 4096 chars)
   */
  private async sendLongMessage(ctx: Context, text: string, threadId?: number): Promise<void> {
    const MAX_LEN = 4000; // Leave some room
    const chunks: string[] = [];

    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LEN) {
        chunks.push(remaining);
        break;
      }

      // Find a good split point
      let splitAt = remaining.lastIndexOf("\n", MAX_LEN);
      if (splitAt < MAX_LEN * 0.5) {
        splitAt = remaining.lastIndexOf(" ", MAX_LEN);
      }
      if (splitAt < MAX_LEN * 0.5) {
        splitAt = MAX_LEN;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    for (const chunk of chunks) {
      await ctx.reply(chunk, { message_thread_id: threadId });
    }
  }

  /**
   * Cache a discovered topic name for future use.
   */
  private cacheTopicName(chatId: string, threadId: number, name: string): void {
    const cacheKey = `${chatId}:${threadId}`;
    this.topicNameCache.set(cacheKey, name);
    console.log(`[Router] Cached topic name: ${name} (${cacheKey})`);
  }

  /**
   * Handle bot commands — returns true if handled.
   */
  private async handleCommand(ctx: Context, text: string, threadId?: number): Promise<boolean> {
    const trimmed = text.trim();
    const chatId = ctx.message!.chat.id.toString();
    const topicKey = this.buildTopicKey(chatId, threadId);

    // /help — list available commands
    if (trimmed === "/help") {
      const lines = [
        "Команды:",
        "/status — активные процессы и настройки",
        "/ttl N — установить TTL (1-1440 мин)",
        "/name <имя> — переименовать текущий топик",
        "/compact — принудительная компрессия контекста",
        "/reset — сбросить сессию (новый диалог с памятью)",
        "/kill — убить процесс текущего топика",
        "/memory — статистика памяти текущего топика",
        "/help — эта справка",
      ];
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    // /status — show active processes
    if (trimmed === "/status") {
      const active = this.processManager.getActiveCount();
      const ttl = this.settings.processes.ttlMinutes;
      const maxConc = this.settings.processes.maxConcurrent;
      const compaction = this.settings.compaction.enabled ? "ON" : "OFF";
      const memory = this.settings.memory.enabled ? "ON" : "OFF";

      const lines = [
        `Активных процессов: ${active}/${maxConc}`,
        `TTL: ${ttl} мин`,
        `Компрессия контекста: ${compaction}`,
        `Ревизия памяти: ${memory}`,
      ];
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    // /ttl N — set TTL in minutes
    const ttlMatch = trimmed.match(/^\/ttl\s+(\d+)$/);
    if (ttlMatch) {
      const newTtl = parseInt(ttlMatch[1], 10);
      if (newTtl < 1 || newTtl > 1440) {
        await ctx.reply("TTL должен быть от 1 до 1440 минут.", { message_thread_id: threadId });
        return true;
      }
      this.settings.processes.ttlMinutes = newTtl;
      this.saveSettings();
      await ctx.reply(`TTL установлен: ${newTtl} мин.`, { message_thread_id: threadId });
      return true;
    }

    // /name <name> — rename current topic
    const nameMatch = trimmed.match(/^\/name\s+(.+)$/);
    if (nameMatch) {
      const newName = nameMatch[1].trim();
      if (!newName) {
        await ctx.reply("Использование: /name <новое имя>", { message_thread_id: threadId });
        return true;
      }

      // Update topics.json
      if (this.topics.topics[topicKey]) {
        this.topics.topics[topicKey].name = newName;
        saveTopics(this.topics);
      }

      // Update cache
      if (threadId) {
        this.cacheTopicName(chatId, threadId, newName);
      }

      await ctx.reply(`Топик переименован: ${newName}`, { message_thread_id: threadId });
      return true;
    }

    // /compact — force context compaction
    if (trimmed === "/compact") {
      const mapping = this.topics.topics[topicKey];
      if (!mapping) {
        await ctx.reply("Топик не инициализирован.", { message_thread_id: threadId });
        return true;
      }

      // Force compaction by sending compaction instruction as the next message
      const compactionMsg = this.compactor.getCompactionPrompt();
      const memoryContext = this.loadMemoryContext(mapping.project, mapping.name);
      const fullMessage = `${memoryContext}\n\n${compactionMsg}\n---\nСообщение от пользователя:\nОбнови topic-memory.md: сохрани все важные решения и факты из нашего диалога, удали устаревшее. Ответь кратко что сохранил.`;

      await ctx.api.sendChatAction(ctx.message!.chat.id, "typing", { message_thread_id: threadId });

      const sessionId = this.processManager.getSessionId(topicKey) || mapping.sessionId;
      const response = await this.processManager.sendMessage(topicKey, mapping.project, fullMessage, sessionId);

      // Reset compaction counters after manual compaction
      this.compactor.resetCounter(topicKey);

      if (response) {
        await this.sendLongMessage(ctx, response, threadId);
      } else {
        await ctx.reply("Компрессия выполнена.", { message_thread_id: threadId });
      }
      return true;
    }

    // /reset — reset session (kill process, start fresh with memory)
    if (trimmed === "/reset") {
      this.processManager.killTopic(topicKey);
      this.compactor.resetCounter(topicKey);

      // Clear session ID so next message starts a new session
      if (this.topics.topics[topicKey]) {
        delete this.topics.topics[topicKey].sessionId;
        saveTopics(this.topics);
      }

      await ctx.reply("Сессия сброшена. Следующее сообщение начнет новый диалог с сохраненной памятью.", { message_thread_id: threadId });
      return true;
    }

    // /kill — kill current topic's process
    if (trimmed === "/kill") {
      const wasActive = this.processManager.killTopic(topicKey);
      if (wasActive) {
        await ctx.reply("Процесс убит.", { message_thread_id: threadId });
      } else {
        await ctx.reply("Нет активного процесса для этого топика.", { message_thread_id: threadId });
      }
      return true;
    }

    // /memory — show memory stats for current topic
    if (trimmed === "/memory") {
      const mapping = this.topics.topics[topicKey];
      if (!mapping) {
        await ctx.reply("Топик не инициализирован.", { message_thread_id: threadId });
        return true;
      }

      const stats = this.memoryManager.getStats(mapping.project);
      const msgCount = this.compactor.getMessageCount(topicKey);
      const charCount = this.compactor.getCharCount(topicKey);

      const lines = [
        `Топик: ${mapping.name}`,
        `Файлов памяти: ${stats.totalFiles}`,
        `Строк: ${stats.totalLines}`,
        `Размер: ${(stats.totalSize / 1024).toFixed(1)} KB`,
        ``,
        `Текущая сессия:`,
        `Сообщений: ${msgCount}`,
        `Символов контекста: ${(charCount / 1000).toFixed(1)}K`,
      ];
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    return false;
  }

  /**
   * Persist current settings to disk.
   */
  private saveSettings(): void {
    const { writeFileSync } = require("fs");
    const { resolve } = require("path");
    const ROOT = resolve(__dirname, "..");
    const path = resolve(ROOT, "config/settings.json");
    writeFileSync(path, JSON.stringify(this.settings, null, 2), "utf-8");
    console.log("[Router] Settings saved");
  }

  private shutdown(): void {
    console.log("[Router] Shutting down...");
    this.memoryManager.stop();
    this.processManager.shutdown();
    this.bot.stop();
    process.exit(0);
  }
}
