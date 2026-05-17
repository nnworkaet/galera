import { readFileSync, writeFileSync, existsSync } from "fs";

export interface VpsServer {
  alias: string;
  host: string;
  user: string;
  keyPath: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  tokenEnvKey: string;
  role: string;
  isOrchestrator: boolean;
  projectDir: string;
  botUsername?: string;
  topicId?: number;   // dedicated Telegram topic for this agent's log
  vps: VpsServer[];
  createdAt: string;
}

export interface AgentsConfig {
  agents: AgentDefinition[];
}

export class AgentRegistry {
  private configPath: string;
  private config: AgentsConfig;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.config = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, "utf-8"))
      : { agents: [] };
  }

  getAll(): AgentDefinition[] {
    return [...this.config.agents];
  }

  getById(id: string): AgentDefinition | undefined {
    return this.config.agents.find((a) => a.id === id);
  }

  getOrchestrator(): AgentDefinition | undefined {
    return this.config.agents.find((a) => a.isOrchestrator);
  }

  getNonOrchestrators(): AgentDefinition[] {
    return this.config.agents.filter((a) => !a.isOrchestrator);
  }

  has(id: string): boolean {
    return this.config.agents.some((a) => a.id === id);
  }

  add(agent: AgentDefinition): void {
    if (this.has(agent.id)) {
      const idx = this.config.agents.findIndex((a) => a.id === agent.id);
      this.config.agents[idx] = agent;
    } else {
      this.config.agents.push(agent);
    }
    this.save();
  }

  remove(id: string): boolean {
    const idx = this.config.agents.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    this.config.agents.splice(idx, 1);
    this.save();
    return true;
  }

  updateBotUsername(id: string, username: string): void {
    const agent = this.config.agents.find((a) => a.id === id);
    if (agent) {
      agent.botUsername = username;
      this.save();
    }
  }

  updateTopicId(id: string, topicId: number): void {
    const agent = this.config.agents.find((a) => a.id === id);
    if (agent) {
      agent.topicId = topicId;
      this.save();
    }
  }

  private save(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
  }
}
