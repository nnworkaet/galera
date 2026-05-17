import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Context } from "grammy";
import { AgentRegistry, type AgentDefinition } from "./AgentRegistry";
import { AgentProcess } from "./AgentProcess";
import type { Settings } from "../config";

interface PendingAgent {
  step: "name" | "role" | "token";
  name: string;
  role: string;
}

export type AgentStartCallback = (agent: AgentProcess) => Promise<void>;
export type CreateTopicFn = (name: string) => Promise<number | null>;

export class AgentFactory {
  private pending = new Map<number, PendingAgent>(); // userId → state
  private registry: AgentRegistry;
  private settings: Settings;
  private rootDir: string;
  private onAgentCreated: AgentStartCallback;
  private createTopic: CreateTopicFn;

  constructor(
    registry: AgentRegistry,
    settings: Settings,
    rootDir: string,
    onAgentCreated: AgentStartCallback,
    createTopic: CreateTopicFn
  ) {
    this.registry = registry;
    this.settings = settings;
    this.rootDir = rootDir;
    this.onAgentCreated = onAgentCreated;
    this.createTopic = createTopic;
  }

  start(ctx: Context, userId: number): void {
    this.pending.set(userId, { step: "name", name: "", role: "" });
    const chatId = ctx.chat!.id;
    const threadId = ctx.message?.message_thread_id;
    ctx.api.sendMessage(
      chatId,
      "Creating a new agent.\n\nEnter the agent name (e.g., DevOps, Analyzer, Security):",
      { message_thread_id: threadId }
    );
  }

  hasPending(userId: number): boolean {
    return this.pending.has(userId);
  }

  cancel(userId: number): void {
    this.pending.delete(userId);
  }

  // Returns true if the message was consumed by the factory flow
  async handleMessage(ctx: Context, text: string, userId: number): Promise<boolean> {
    const state = this.pending.get(userId);
    if (!state) return false;

    const chatId = ctx.chat!.id;
    const threadId = ctx.message?.message_thread_id;

    if (state.step === "name") {
      const raw = text.trim();
      const name = raw.replace(/\s+/g, "_");
      if (!name || !/^[\w-]+$/i.test(name)) {
        await ctx.api.sendMessage(
          chatId,
          "Invalid name. Use only letters, digits, or underscore. Try again:",
          { message_thread_id: threadId }
        );
        return true;
      }
      const id = name.toLowerCase();
      if (this.registry.has(id)) {
        await ctx.api.sendMessage(
          chatId,
          `Agent "${id}" already exists. Choose a different name:`,
          { message_thread_id: threadId }
        );
        return true;
      }
      state.name = name;
      state.step = "role";
      await ctx.api.sendMessage(
        chatId,
        `Name: ${name}\n\nDescribe the agent's role and capabilities (used as its system prompt):`,
        { message_thread_id: threadId }
      );
      return true;
    }

    if (state.step === "role") {
      state.role = text.trim();
      const tokenKey = `TELEGRAM_${state.name.toUpperCase()}_TOKEN`;
      state.step = "token";
      await ctx.api.sendMessage(
        chatId,
        `Role saved.\n\nNow send the Telegram bot token for ${state.name}.\n\n` +
          `Create the bot via @BotFather, then paste the token here.\n` +
          `It will be saved as: ${tokenKey}`,
        { message_thread_id: threadId }
      );
      return true;
    }

    if (state.step === "token") {
      const token = text.trim();
      if (!/^\d+:[\w-]+$/.test(token)) {
        await ctx.api.sendMessage(
          chatId,
          "Invalid token format (expected 1234567890:AAF...). Try again:",
          { message_thread_id: threadId }
        );
        return true;
      }

      const id = state.name.toLowerCase();
      const tokenKey = `TELEGRAM_${state.name.toUpperCase()}_TOKEN`;

      this.appendToEnv(tokenKey, token);
      process.env[tokenKey] = token;

      const agentDef: AgentDefinition = {
        id,
        name: state.name,
        tokenEnvKey: tokenKey,
        role: state.role,
        isOrchestrator: false,
        projectDir: `projects/${id}`,
        vps: [],
        createdAt: new Date().toISOString(),
      };

      this.registry.add(agentDef);
      this.pending.delete(userId);

      try {
        const agentProcess = new AgentProcess(agentDef, this.settings);
        await agentProcess.init();

        // Create dedicated topic in the group (CEO bot has admin rights)
        const topicId = await this.createTopic(state.name);
        if (topicId) {
          agentDef.topicId = topicId;
          agentProcess.config.topicId = topicId;
          this.registry.updateTopicId(id, topicId);
        }

        await this.onAgentCreated(agentProcess);
        const username = agentProcess.username;
        const topicNote = topicId ? `\nТопик для логов создан автоматически.` : "";
        await ctx.api.sendMessage(
          chatId,
          `✅ Агент ${state.name} (@${username}) создан и запущен!${topicNote}\n\nДобавь @${username} в группу.`,
          { message_thread_id: threadId }
        );
      } catch (err: any) {
        await ctx.api.sendMessage(
          chatId,
          `⚠️ Определение агента сохранено, но запуск не удался: ${err.message}\n\nИсправь токен в .env и перезапусти.`,
          { message_thread_id: threadId }
        );
      }

      return true;
    }

    return false;
  }

  private appendToEnv(key: string, value: string): void {
    const envPath = resolve(this.rootDir, ".env");
    let content = "";
    if (existsSync(envPath)) {
      content = readFileSync(envPath, "utf-8");
      // Remove existing line for this key
      content = content.replace(new RegExp(`^${key}=.*$\\r?\\n?`, "m"), "");
    }
    content = content.trimEnd() + `\n${key}=${value}\n`;
    writeFileSync(envPath, content, "utf-8");
  }
}
