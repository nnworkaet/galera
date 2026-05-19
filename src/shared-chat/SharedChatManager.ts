import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Context } from "grammy";
import { ChatHistory } from "./ChatHistory";
import { MessageBroker } from "./MessageBroker";
import type { AgentProcess } from "../agents/AgentProcess";
import type { LtmManager } from "../memory/LtmManager";

// Sends "typing" action repeatedly until stop() is called
function startTyping(agent: AgentProcess, chatId: number, threadId: number): { stop: () => void } {
  let active = true;
  const tick = async () => {
    while (active) {
      try {
        await agent.bot.api.sendChatAction(chatId, "typing", { message_thread_id: threadId });
      } catch {}
      await new Promise((r) => setTimeout(r, 4000));
    }
  };
  tick();
  return { stop: () => { active = false; } };
}

// Parse @AgentName or @AgentName: or @AgentName — delegation lines
const DELEGATE_RE = /@(\w+)[\s:—–-]+(.+)/gi;

export interface Delegation {
  agentName: string;
  task: string;
}

export class SharedChatManager {
  private agents = new Map<string, AgentProcess>(); // id → AgentProcess
  private orchestratorId: string;
  private broker: MessageBroker;
  private history: ChatHistory;
  private groupChatId: number;
  private generalTopicId: number;
  private ltmManager?: LtmManager;

  private compressThreshold: number;

  // Concurrency guard — only one user message processed at a time
  private busy = false;
  private pending: Array<() => Promise<void>> = [];

  constructor(opts: {
    orchestratorId: string;
    history: ChatHistory;
    broker: MessageBroker;
    groupChatId: number;
    generalTopicId: number;
    ltmManager?: LtmManager;
    compressThreshold?: number;
  }) {
    this.orchestratorId = opts.orchestratorId;
    this.history = opts.history;
    this.broker = opts.broker;
    this.groupChatId = opts.groupChatId;
    this.generalTopicId = opts.generalTopicId;
    this.ltmManager = opts.ltmManager;
    this.compressThreshold = opts.compressThreshold ?? 300;
  }

  registerAgent(agent: AgentProcess): void {
    this.agents.set(agent.config.id, agent);
  }

  // Called by orchestrator bot when user sends to General
  async handleUserMessage(ctx: Context, text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push(async () => {
        await this._process(ctx, text);
        resolve();
      });
      if (!this.busy) this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.busy || this.pending.length === 0) return;
    this.busy = true;
    const task = this.pending.shift()!;
    try {
      await task();
    } finally {
      this.busy = false;
      if (this.pending.length > 0) this.drain();
    }
  }

  private async _process(ctx: Context, text: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const chatId = ctx.chat!.id;
    const threadId = this.generalTopicId;

    this.history.append({ timestamp, role: "user", content: text });

    const orchestrator = this.agents.get(this.orchestratorId);
    if (!orchestrator) {
      console.error("[SharedChatManager] Orchestrator not registered");
      return;
    }

    // Orchestrator gets the floor
    this.broker.acquireForOrchestrator(this.orchestratorId);

    const orchTyping = startTyping(orchestrator, chatId, threadId);
    const prompt = this.buildOrchestratorPrompt(text);

    let orchResponse = "";
    try {
      orchResponse = await orchestrator.runClaude(prompt, `general:${this.orchestratorId}`);
      orchTyping.stop();
    } catch (err: any) {
      orchTyping.stop();
      await orchestrator.sendToTopic(chatId, threadId, `Ошибка — ${err.message}`);
      this.broker.release(this.orchestratorId);
      return;
    }

    const cleanOrch = this.stripDone(orchResponse);
    if (cleanOrch.trim()) {
      this.history.append({ timestamp: new Date().toISOString(), role: "agent", agentName: orchestrator.config.name, content: cleanOrch });
      this.broker.trackMessage(this.orchestratorId);
      await orchestrator.sendToTopic(chatId, threadId, cleanOrch);

      // Log to CEO's dedicated topic
      const ceoTopicId = orchestrator.config.topicId;
      if (ceoTopicId && ceoTopicId !== threadId) {
        await orchestrator.sendToTopic(this.groupChatId, ceoTopicId,
          `👤 User:\n${text}\n\n📤 Response:\n${cleanOrch}`
        ).catch(() => {});
      }
    }

    this.broker.release(this.orchestratorId);

    // Parse delegation groups: same paragraph = parallel, different paragraphs = sequential
    const groups = this.parseDelegationGroups(cleanOrch);
    console.log(`[SharedChatManager] ${groups.length} delegation group(s)`);

    for (const group of groups) {
      if (this.broker.isChainExhausted()) {
        await orchestrator.sendToTopic(chatId, threadId, `Достигнут лимит цепочки.`);
        break;
      }

      const tasks: Promise<void>[] = [];
      for (const d of group) {
        const agent = this.findAgentByName(d.agentName);
        if (!agent) {
          console.warn(`[SharedChatManager] Agent "${d.agentName}" not found`);
          continue;
        }
        if (!this.broker.tryAcquire(agent.config.id)) {
          await orchestrator.sendToTopic(chatId, threadId, `${agent.config.name} уже занят — пропускаю.`);
          continue;
        }
        tasks.push(this.runDelegate(agent, d, chatId, threadId));
      }

      // Wait for this group to fully complete before starting the next group
      if (tasks.length > 0) {
        console.log(`[SharedChatManager] Running ${tasks.length} agent(s) in parallel`);
        await Promise.allSettled(tasks);
      }
    }

    // Auto-compress history if it has grown too large
    await this.maybeCompressHistory(orchestrator);
  }

  private async maybeCompressHistory(orchestrator: AgentProcess): Promise<void> {
    const lines = this.history.getLineCount();
    if (lines < this.compressThreshold) return;

    console.log(`[SharedChatManager] History at ${lines} lines (threshold ${this.compressThreshold}), compressing...`);
    await this.runHistoryCompression(orchestrator);
  }

  private async runHistoryCompression(orchestrator: AgentProcess): Promise<void> {
    const fullHistory = this.history.read();
    const date = new Date().toISOString().slice(0, 10);

    const prompt = [
      `The conversation history has grown too long and must be compressed.`,
      `Here is the full history:`,
      ``,
      `---`,
      fullHistory,
      `---`,
      ``,
      `Compress it into a concise summary that preserves:`,
      `- All key decisions, outcomes, and facts`,
      `- Server configs, credentials, or technical details mentioned`,
      `- The last 15 messages verbatim (under "## Recent Messages")`,
      ``,
      `Respond with ONLY the new history content in markdown — no preamble, no explanation.`,
      `Start with: # History (compressed ${date})`,
      `End your response with DONE on its own line.`,
    ].join("\n");

    // Run in a temp dir so it doesn't interfere with the orchestrator's --continue session
    const tmpDir = mkdtempSync(join(tmpdir(), "galera-compress-"));
    try {
      const raw = await orchestrator.pm.runOnce(tmpDir, prompt);
      const compressed = this.stripDone(raw);
      if (compressed.length > 200) {
        this.history.replace(compressed);
        console.log(`[SharedChatManager] History compressed: ${fullHistory.length} → ${compressed.length} chars`);
      } else {
        console.warn(`[SharedChatManager] Compression returned too little content, skipping`);
      }
    } catch (err: any) {
      console.error(`[SharedChatManager] History compression failed: ${err.message}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private async runDelegate(
    agent: AgentProcess,
    d: Delegation,
    chatId: number,
    threadId: number
  ): Promise<void> {
    try {
      const topicKey = `general:${agent.config.id}`;
      const cleanAgent = await this.runAgentWithRetry(agent, d.task, topicKey, chatId, threadId);

      if (cleanAgent.trim()) {
        this.history.append({ timestamp: new Date().toISOString(), role: "agent", agentName: agent.config.name, content: cleanAgent });
        this.broker.trackMessage(agent.config.id);
        await agent.sendToTopic(chatId, threadId, cleanAgent);

        const agentTopicId = agent.config.topicId;
        if (agentTopicId) {
          await agent.sendToTopic(this.groupChatId, agentTopicId,
            `📥 Task:\n${d.task}\n\n📤 Response:\n${cleanAgent}`
          ).catch(() => {});
        }
      }
    } finally {
      this.broker.release(agent.config.id);
    }
  }

  private async runAgentWithRetry(
    agent: AgentProcess,
    task: string,
    topicKey: string,
    chatId: number,
    threadId: number,
    maxRetries = 2
  ): Promise<string> {
    let lastError = "";
    let prompt = this.buildDelegatePrompt(agent.config.name, task);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const typing = startTyping(agent, chatId, threadId);
      try {
        const raw = await agent.runClaude(prompt, topicKey);
        typing.stop();
        return this.stripDone(raw);
      } catch (err: any) {
        typing.stop();
        lastError = (err as Error).message;
        console.warn(`[SharedChatManager] ${agent.config.name} attempt ${attempt + 1} failed: ${lastError}`);

        if (attempt < maxRetries) {
          prompt = [
            `You were given this task:`,
            `TASK: ${task}`,
            ``,
            `Your previous attempt failed with the following error:`,
            `ERROR: ${lastError}`,
            ``,
            `Analyse what went wrong, then retry the task using a different approach.`,
            `If it was a timeout, break the work into smaller steps.`,
            `If SSH failed, double-check credentials and try again.`,
            `Report progress as you go. End with [DONE].`,
          ].join("\n");

          try { await agent.sendToTopic(chatId, threadId, `⚠️ Ошибка (попытка ${attempt + 1}/${maxRetries + 1}): ${lastError}\nПовторяю...`); } catch {}
        }
      }
    }

    // All retries exhausted — report to orchestrator
    const exhaustedMsg = `❌ Не удалось выполнить задачу после ${maxRetries + 1} попыток. Последняя ошибка: ${lastError}`;
    try { await agent.sendToTopic(chatId, threadId, exhaustedMsg); } catch {}
    return exhaustedMsg;
  }

  private buildLtmContext(userMessage: string): string {
    if (!this.ltmManager) return "";
    const results = this.ltmManager.search(userMessage);
    if (!results.length) return "";
    const parts = results.slice(0, 3).map(
      (r) => `[LTM: ${r.entry.file}#${r.entry.anchor}]\n${r.section.slice(0, 500)}\n[/LTM]`
    );
    return parts.join("\n\n") + "\n\n";
  }

  private buildOrchestratorPrompt(userMessage: string): string {
    const agentNames = Array.from(this.agents.values())
      .filter((a) => !a.config.isOrchestrator)
      .map((a) => a.config.name)
      .join(", ");

    return (
      this.buildLtmContext(userMessage) +
      [
        `User message in General chat:`,
        `"${userMessage}"`,
        ``,
        `Full conversation history: ${this.history.getFilePath()}`,
        `Read it with the Read tool before responding.`,
        ``,
        `Available agents: ${agentNames || "none yet"}`,
        `To delegate: @AgentName: <task description>`,
        ``,
        `IMPORTANT: Delegated agents do NOT have access to the conversation history.`,
        `You MUST include all necessary context directly in each task description —`,
        `relevant facts, server addresses, previous results, expected outcomes.`,
        `The task description must be fully self-contained.`,
      ].join("\n")
    );
  }

  private buildDelegatePrompt(agentName: string, task: string): string {
    return (
      this.buildLtmContext(task) +
      [
        `You (${agentName}) have been delegated a task by the orchestrator.`,
        `All context needed to complete the task is included below.`,
        ``,
        `TASK:`,
        task,
        ``,
        `Complete the task and report results. End with [DONE].`,
      ].join("\n")
    );
  }

  // Split by blank lines → each paragraph is a parallel group
  private parseDelegationGroups(text: string): Delegation[][] {
    const groups: Delegation[][] = [];
    const seenAgents = new Set<string>();

    for (const paragraph of text.split(/\n\s*\n/)) {
      const group: Delegation[] = [];
      const pattern = new RegExp(DELEGATE_RE.source, "gi");
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(paragraph)) !== null) {
        const name = match[1];
        const lower = name.toLowerCase();
        const task = match[2].trim().replace(/\[DONE\]/gi, "").trim();
        if (task && !seenAgents.has(lower)) {
          seenAgents.add(lower);
          group.push({ agentName: name, task });
        }
      }
      if (group.length > 0) groups.push(group);
    }
    return groups;
  }

  private findAgentByName(name: string): AgentProcess | undefined {
    const lower = name.toLowerCase();
    for (const agent of this.agents.values()) {
      if (agent.config.name.toLowerCase() === lower || agent.config.id.toLowerCase() === lower) {
        return agent;
      }
    }
    return undefined;
  }

  private stripDone(text: string): string {
    return text.replace(/\[DONE\]\s*$/i, "").trim();
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  getAgentList(): AgentProcess[] {
    return Array.from(this.agents.values());
  }
}
