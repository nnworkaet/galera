import { resolve } from "path";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import { InputFile } from "grammy";
import type { Context } from "grammy";

import { loadSettings } from "./config";
import { useI18n } from "./i18n";
import { AgentRegistry } from "./agents/AgentRegistry";
import { AgentProcess } from "./agents/AgentProcess";
import { AgentFactory } from "./agents/AgentFactory";
import { SharedChatManager, ChatHistory, MessageBroker } from "./shared-chat";
import { SecretsManager } from "./secrets/SecretsManager";
import { LtmManager } from "./memory/LtmManager";
import { UsageTracker } from "./memory/UsageTracker";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Load .env before anything else
function loadEnv(): void {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const settings = loadSettings();
const t = useI18n(settings.language ?? "ru");
const registry = new AgentRegistry(resolve(ROOT, "config/agents.json"));

// Secrets → shared memory
const sharedMemPath = resolve(settings.projectsRoot, "projects/_shared/main-memory.md");
const secretsPath = resolve(ROOT, "config/.secrets.json");
const secrets = new SecretsManager(secretsPath, sharedMemPath);
secrets.ensureSharedMemoryBase();

// LTM and usage tracking
const sharedLtmDir = resolve(settings.projectsRoot, "projects/_shared/ltm");
const ltmManager = new LtmManager(sharedLtmDir);
const usageTracker = new UsageTracker(resolve(ROOT, "config/usage.json"), settings.usageLimits);

// Multi-agent config
const ma = settings.multiAgent;
const groupChatId: number = ma?.groupChatId ?? 0;
const generalTopicId: number = ma?.generalTopicId ?? 0;

// Shared chat infrastructure
const historyPath = resolve(settings.projectsRoot, "projects/_shared/history.md");
const history = new ChatHistory(historyPath);

const broker = new MessageBroker({
  maxChainLength: ma?.maxChainLength ?? 5,
  agentCooldownSec: ma?.agentCooldownSec ?? 5,
  maxMessagesPerTurn: ma?.maxMessagesPerTurn ?? 3,
  tokenTimeoutSec: ma?.tokenTimeoutSec ?? 60,
});

const orchestratorDef = registry.getOrchestrator();
if (!orchestratorDef) {
  console.error("[Boot] No orchestrator in config/agents.json. Add one with isOrchestrator:true.");
  process.exit(1);
}

const sharedChatManager = new SharedChatManager({
  orchestratorId: orchestratorDef.id,
  history,
  broker,
  groupChatId,
  generalTopicId,
  ltmManager,
  compressThreshold: settings.multiAgent?.historyCompressLines ?? 300,
});

// Running agents index
const runningAgents = new Map<string, AgentProcess>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sendMdFile(
  bot: AgentProcess["bot"],
  chatId: number,
  threadId: number | undefined,
  filename: string,
  content: string,
  caption?: string
): Promise<void> {
  const buf = Buffer.from(content, "utf-8");
  try {
    await bot.api.sendDocument(
      chatId,
      new InputFile(buf, filename),
      { message_thread_id: threadId, caption }
    );
  } catch {
    // fallback: send as text if document upload fails
    await bot.api.sendMessage(chatId, `${caption ?? filename}\n\n${content.slice(0, 3800)}`, {
      message_thread_id: threadId,
    });
  }
}

// ─── CEO command handler ─────────────────────────────────────────────────────

async function handleCeoCommand(
  ceo: AgentProcess,
  ctx: Context,
  text: string,
  threadId: number | undefined,
  userId: number,
  factory: AgentFactory
): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const trimmed = text.trim();

  if (trimmed === "/new_agent") {
    factory.start(ctx, userId);
    return true;
  }

  if (trimmed === "/cancel") {
    factory.cancel(userId);
    await ctx.api.sendMessage(chatId, t.cancelled, { message_thread_id: threadId });
    return true;
  }

  if (trimmed === "/agents") {
    const agents = registry.getAll();
    if (!agents.length) {
      await ctx.api.sendMessage(chatId, t.agents_none, { message_thread_id: threadId });
    } else {
      const lines = agents.map((a) => {
        const running = runningAgents.has(a.id) ? "✅" : "❌";
        const role = a.isOrchestrator ? t.agent_role_orchestrator : a.role;
        return `• ${a.name} (${a.id}) — ${role} ${running}`;
      });
      await ctx.api.sendMessage(chatId, `${t.agents_header}\n${lines.join("\n")}`, {
        message_thread_id: threadId,
      });
    }
    return true;
  }

  const killMatch = trimmed.match(/^\/kill_agent\s+(\S+)$/);
  if (killMatch) {
    const id = killMatch[1].toLowerCase();
    const agent = runningAgents.get(id);
    if (agent) {
      agent.stopBot();
      runningAgents.delete(id);
      sharedChatManager.unregisterAgent(id);
    }
    const removed = registry.remove(id);
    await ctx.api.sendMessage(
      chatId,
      removed ? t.agent_removed(id) : t.agent_not_found(id),
      { message_thread_id: threadId }
    );
    return true;
  }

  // /secret_set KEY VALUE
  const secretSetMatch = trimmed.match(/^\/secret_set\s+(\S+)\s+(.+)$/);
  if (secretSetMatch) {
    secrets.set(secretSetMatch[1], secretSetMatch[2].trim());
    await ctx.api.sendMessage(chatId, t.secret_saved(secretSetMatch[1]), {
      message_thread_id: threadId,
    });
    return true;
  }

  if (trimmed === "/secret_list") {
    const keys = secrets.list();
    await ctx.api.sendMessage(
      chatId,
      keys.length ? t.secrets_list(keys.join(", ")) : t.secrets_empty,
      { message_thread_id: threadId }
    );
    return true;
  }

  const secretDelMatch = trimmed.match(/^\/secret_delete\s+(\S+)$/);
  if (secretDelMatch) {
    const deleted = secrets.delete(secretDelMatch[1]);
    await ctx.api.sendMessage(
      chatId,
      deleted ? t.secret_deleted(secretDelMatch[1]) : t.secret_not_found,
      { message_thread_id: threadId }
    );
    return true;
  }

  if (trimmed === "/secret_reload") {
    secrets.reload();
    await ctx.api.sendMessage(chatId, t.secrets_reloaded, {
      message_thread_id: threadId,
    });
    return true;
  }

  if (trimmed === "/setup_general") {
    const chatNumId = ctx.chat!.id;
    if (!threadId) {
      await ctx.api.sendMessage(chatId, t.setup_need_topic, {
        message_thread_id: threadId,
      });
      return true;
    }
    if (!settings.multiAgent) settings.multiAgent = { groupChatId: chatNumId, generalTopicId: threadId };
    settings.multiAgent.groupChatId = chatNumId;
    settings.multiAgent.generalTopicId = threadId;
    const { writeFileSync } = await import("fs");
    writeFileSync(
      resolve(ROOT, "config/settings.json"),
      JSON.stringify(settings, null, 2),
      "utf-8"
    );
    await ctx.api.sendMessage(chatId, t.setup_done(threadId, chatNumId), { message_thread_id: threadId });
    return true;
  }

  // /status — статистика использования и памяти
  if (trimmed === "/status") {
    const agentDescriptors = Array.from(runningAgents.values()).map((a) => ({
      name: a.config.name,
      projectPath: a.projectPath,
    }));
    const status = usageTracker.getFormattedStatus(agentDescriptors, sharedLtmDir, settings.language ?? "ru");
    await ceo.sendToTopic(chatId, threadId, status);
    return true;
  }

  // /compact — сжать контекст сессии
  if (trimmed === "/compact") {
    await ctx.api.sendMessage(chatId, t.compact_start, { message_thread_id: threadId });
    const agents = Array.from(runningAgents.values());
    let done = 0;
    for (const agent of agents) {
      try {
        await agent.runClaude(
          t.compact_prompt,
          `compact:${agent.config.id}`
        );
        done++;
      } catch {}
    }
    await ctx.api.sendMessage(chatId, t.compact_done(done, agents.length), { message_thread_id: threadId });
    return true;
  }

  // /recall <запрос> — поиск в долгосрочной памяти
  const recallMatch = trimmed.match(/^\/recall\s+(.+)$/);
  if (recallMatch) {
    const query = recallMatch[1].trim();
    const results = ltmManager.search(query);
    if (!results.length) {
      await ctx.api.sendMessage(chatId, t.recall_none(query), {
        message_thread_id: threadId,
      });
    } else {
      await ctx.api.sendMessage(chatId, t.recall_found(results.length), { message_thread_id: threadId });
      for (const r of results.slice(0, 3)) {
        const filename = `ltm_${r.entry.file.replace(/\.md$/, "")}_${r.entry.anchor}.md`;
        await sendMdFile(ceo.bot, chatId, threadId, filename, r.section,
          `📚 ${r.entry.file}#${r.entry.anchor} — ${r.entry.description}`);
      }
    }
    return true;
  }

  // /ltm_list — индекс LTM
  if (trimmed === "/ltm_list") {
    const index = ltmManager.getIndex();
    if (!index.trim()) {
      await ctx.api.sendMessage(chatId, t.ltm_empty, { message_thread_id: threadId });
    } else {
      await sendMdFile(ceo.bot, chatId, threadId, "_index.md", index, t.ltm_index_caption);
    }
    return true;
  }

  // /ltm_show <файл> — показать файл из LTM
  const ltmShowMatch = trimmed.match(/^\/ltm_show\s+(\S+)$/);
  if (ltmShowMatch) {
    const file = ltmShowMatch[1].endsWith(".md") ? ltmShowMatch[1] : `${ltmShowMatch[1]}.md`;
    const content = ltmManager.getFile(file);
    if (!content) {
      await ctx.api.sendMessage(chatId, t.ltm_not_found(file), {
        message_thread_id: threadId,
      });
    } else {
      await sendMdFile(ceo.bot, chatId, threadId, file, content, t.ltm_file_caption(file));
    }
    return true;
  }

  // /memory — все файлы памяти
  if (trimmed === "/memory") {
    let sent = 0;

    // main-memory.md (общая)
    const mainMem = resolve(settings.projectsRoot, "projects/_shared/main-memory.md");
    if (existsSync(mainMem)) {
      await sendMdFile(ceo.bot, chatId, threadId, "main-memory.md",
        readFileSync(mainMem, "utf-8"), t.memory_main_caption);
      sent++;
    }

    // topic-memory.md каждого агента
    const projectsBase = resolve(settings.projectsRoot, "projects");
    for (const agent of runningAgents.values()) {
      const topicMem = join(projectsBase, agent.config.projectDir, "topic-memory.md");
      if (existsSync(topicMem)) {
        await sendMdFile(ceo.bot, chatId, threadId,
          `topic-memory-${agent.config.id}.md`,
          readFileSync(topicMem, "utf-8"),
          t.memory_topic_caption(agent.config.name)
        );
        sent++;
      }
    }

    // LTM index
    const ltmIndex = ltmManager.getIndex();
    if (ltmIndex.trim()) {
      await sendMdFile(ceo.bot, chatId, threadId, "_index.md", ltmIndex, t.memory_ltm_caption);
      sent++;
    }

    if (sent === 0) {
      await ctx.api.sendMessage(chatId, t.memory_empty, { message_thread_id: threadId });
    }
    return true;
  }

  if (trimmed === "/help") {
    await ctx.api.sendMessage(chatId, t.help, { message_thread_id: threadId });
    return true;
  }

  return false;
}

// ─── Agent wiring ────────────────────────────────────────────────────────────

async function startAgent(agent: AgentProcess, factory: AgentFactory): Promise<void> {
  const def = agent.config;

  if (def.isOrchestrator) {
    agent.onGeneralMessage = async (ctx: Context, text: string, threadId: number) => {
      const userId = ctx.message!.from!.id;

      if (factory.hasPending(userId)) {
        if (await factory.handleMessage(ctx, text, userId)) return;
      }
      if (text.startsWith("/")) {
        if (await handleCeoCommand(agent, ctx, text, threadId, userId, factory)) return;
      }
      // Route through shared chat (orchestrator speaks first, then delegates)
      await sharedChatManager.handleUserMessage(ctx, text);
    };

    agent.onPrivateTopicMessage = async (
      ctx: Context,
      text: string,
      topicKey: string,
      threadId?: number
    ) => {
      const userId = ctx.message!.from!.id;
      const chatId = ctx.chat!.id;

      if (factory.hasPending(userId)) {
        if (await factory.handleMessage(ctx, text, userId)) return;
      }
      if (text.startsWith("/")) {
        if (await handleCeoCommand(agent, ctx, text, threadId, userId, factory)) return;
      }
      // Private direct conversation with CEO Claude process
      try { await ctx.api.sendChatAction(chatId, "typing", { message_thread_id: threadId }); } catch {}
      const response = await agent.runClaude(text, topicKey);
      if (response) await agent.sendToTopic(chatId, threadId, response);
    };
  } else {
    // Specialist: respond only in private topics (not General — only via delegation)
    agent.onPrivateTopicMessage = async (
      ctx: Context,
      text: string,
      topicKey: string,
      threadId?: number
    ) => {
      const chatId = ctx.chat!.id;
      try { await ctx.api.sendChatAction(chatId, "typing", { message_thread_id: threadId }); } catch {}
      const response = await agent.runClaude(text, topicKey);
      if (response) await agent.sendToTopic(chatId, threadId, response);
    };
  }

  // Hook real token counts into usage tracker
  agent.pm.onTokensUsed = (input, output) => usageTracker.track(input + output);

  sharedChatManager.registerAgent(agent);
  runningAgents.set(def.id, agent);

  // Register bot commands for Telegram autocomplete
  try {
    if (def.isOrchestrator) {
      await agent.bot.api.setMyCommands([
        { command: "new_agent",      description: "Добавить нового агента" },
        { command: "agents",         description: "Список агентов и статус" },
        { command: "kill_agent",     description: "Остановить агента: /kill_agent <id>" },
        { command: "secret_set",     description: "Сохранить секрет: /secret_set KEY VALUE" },
        { command: "secret_list",    description: "Список ключей секретов" },
        { command: "secret_delete",  description: "Удалить секрет: /secret_delete KEY" },
        { command: "secret_reload",  description: "Обновить секреты в shared memory" },
        { command: "setup_general",  description: "Настроить этот топик как General" },
        { command: "status",         description: "Статистика использования и память" },
        { command: "compact",        description: "Сжать контекст сессии агентов" },
        { command: "recall",         description: "Поиск в долгосрочной памяти: /recall <query>" },
        { command: "ltm_list",       description: "Список всех записей LTM" },
        { command: "ltm_show",       description: "Показать файл LTM: /ltm_show <file>" },
        { command: "memory",         description: "Показать все файлы памяти" },
        { command: "cancel",         description: "Отменить текущую операцию" },
        { command: "help",           description: "Справка по командам" },
      ]);
    } else {
      await agent.bot.api.setMyCommands([
        { command: "help", description: "Справка" },
      ]);
    }
  } catch (err: any) {
    console.warn(`[${def.id}] setMyCommands failed: ${err.message}`);
  }

  agent.setupHandlers(
    settings,
    settings.telegram.allowedUsers,
    generalTopicId || null,
    groupChatId
  );

  // Start polling in background
  agent.startBot().catch((err: Error) =>
    console.error(`[${def.id}] Bot crashed:`, err.message)
  );
}

// ─── Boot ────────────────────────────────────────────────────────────────────

console.log("===========================================");
console.log("  TeleClaude Multi-Agent System");
console.log("===========================================");
console.log(`[Boot] Projects root: ${settings.projectsRoot}`);
console.log(`[Boot] Group chat ID: ${groupChatId || "(not configured)"}`);
console.log(`[Boot] General topic: ${generalTopicId || "(not configured)"}`);
console.log(`[Boot] LTM dir: ${sharedLtmDir}`);

const agentDefs = registry.getAll();
if (!agentDefs.length) {
  console.error("[Boot] No agents in config/agents.json");
  process.exit(1);
}

// CEO agent reference — needed to create topics (CEO has admin rights)
let ceoAgent: AgentProcess | null = null;

async function createGroupTopic(name: string): Promise<number | null> {
  if (!ceoAgent || !groupChatId) return null;
  return ceoAgent.createTopic(groupChatId, name);
}

// Factory created after sharedChatManager so startAgent can use it
const factory = new AgentFactory(registry, settings, ROOT,
  async (newAgent: AgentProcess) => { await startAgent(newAgent, factory); },
  createGroupTopic
);

for (const def of agentDefs) {
  try {
    const agent = new AgentProcess(def, settings);
    await agent.init();

    // CEO must be started first so createGroupTopic works for subsequent agents
    if (def.isOrchestrator) ceoAgent = agent;

    // Create dedicated topic if missing and group is configured
    if (!def.topicId && groupChatId && ceoAgent) {
      const topicId = await createGroupTopic(def.name);
      if (topicId) {
        def.topicId = topicId;
        agent.config.topicId = topicId;
        registry.updateTopicId(def.id, topicId);
        console.log(`[Boot] Created topic "${def.name}" → ${topicId}`);
      }
    }

    await startAgent(agent, factory);
    console.log(`[Boot] ✅ ${def.name} (@${agent.username})${def.topicId ? ` topic:${def.topicId}` : ""}`);
  } catch (err: any) {
    console.error(`[Boot] ❌ ${def.id}: ${err.message}`);
  }
}

console.log(`[Boot] ${runningAgents.size}/${agentDefs.length} agents running.`);

if (!groupChatId || !generalTopicId) {
  console.warn(
    "[Boot] WARNING: multiAgent.groupChatId or generalTopicId not set in settings.json.\n" +
      "         Run /setup general inside the General topic to configure automatically."
  );
}

// Graceful shutdown
function shutdown(): void {
  console.log("[Shutdown] Stopping all agents...");
  for (const agent of runningAgents.values()) {
    agent.stopBot();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
