export class MessageBroker {
  private activeAgents = new Set<string>();
  private agentMessageCount = new Map<string, number>();
  private chainCount = 0;
  private lastActivity = new Map<string, number>();
  private agentTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly maxChainLength: number;
  private readonly agentCooldownMs: number;
  private readonly maxMessagesPerTurn: number;
  private readonly tokenTimeoutMs: number;

  constructor(opts: {
    maxChainLength?: number;
    agentCooldownSec?: number;
    maxMessagesPerTurn?: number;
    tokenTimeoutSec?: number;
  } = {}) {
    this.maxChainLength = opts.maxChainLength ?? 10;
    this.agentCooldownMs = (opts.agentCooldownSec ?? 5) * 1000;
    this.maxMessagesPerTurn = opts.maxMessagesPerTurn ?? 3;
    this.tokenTimeoutMs = (opts.tokenTimeoutSec ?? 1800) * 1000; // 30 min default for long tasks
  }

  // Orchestrator resets chain and acquires slot
  acquireForOrchestrator(agentId: string): void {
    this.resetChain();
    this.activeAgents.add(agentId);
    this.scheduleTimeout(agentId);
  }

  // Specialist agents: multiple can be active simultaneously
  tryAcquire(agentId: string): boolean {
    if (this.activeAgents.has(agentId)) return false; // already running
    if (!this.checkCooldown(agentId)) return false;
    this.activeAgents.add(agentId);
    this.scheduleTimeout(agentId);
    return true;
  }

  release(agentId?: string): void {
    if (agentId) {
      this.activeAgents.delete(agentId);
      const t = this.agentTimeouts.get(agentId);
      if (t) { clearTimeout(t); this.agentTimeouts.delete(agentId); }
    } else {
      for (const id of this.activeAgents) this.release(id);
    }
  }

  trackMessage(agentId: string): void {
    this.agentMessageCount.set(agentId, (this.agentMessageCount.get(agentId) ?? 0) + 1);
    this.lastActivity.set(agentId, Date.now());
    this.chainCount++;
  }

  isRateLimited(agentId: string): boolean {
    return (this.agentMessageCount.get(agentId) ?? 0) >= this.maxMessagesPerTurn;
  }

  isChainExhausted(): boolean {
    return this.chainCount >= this.maxChainLength;
  }

  resetChain(): void {
    this.chainCount = 0;
    this.agentMessageCount.clear();
    this.release();
  }

  private checkCooldown(agentId: string): boolean {
    const last = this.lastActivity.get(agentId);
    if (!last) return true;
    return Date.now() - last >= this.agentCooldownMs;
  }

  private scheduleTimeout(agentId: string): void {
    const existing = this.agentTimeouts.get(agentId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      console.log(`[MessageBroker] Timeout for ${agentId}, releasing`);
      this.release(agentId);
    }, this.tokenTimeoutMs);
    this.agentTimeouts.set(agentId, t);
  }
}
