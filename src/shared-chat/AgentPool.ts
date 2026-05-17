import { ProcessManager } from "../process-manager";
import type { AgentConfig, SharedChatConfig, Settings } from "../config";
import { join } from "path";

export interface AgentResult {
  agentId: string;
  agentName: string;
  output: string;
  success: boolean;
  error?: string;
}

export class AgentPool {
  private processManager: ProcessManager;
  private config: SharedChatConfig;
  private agentsDir: string;

  constructor(config: SharedChatConfig, agentsDir: string, settings: Settings) {
    this.config = config;
    this.agentsDir = agentsDir;
    // One shared ProcessManager — each agent uses its own topicKey "shared:<agentId>"
    this.processManager = new ProcessManager(settings);
  }

  async runAgent(agentId: string, prompt: string): Promise<AgentResult> {
    const agentCfg = this.config.agents.find((a) => a.id === agentId);
    if (!agentCfg) {
      return {
        agentId,
        agentName: agentId,
        output: "",
        success: false,
        error: `Agent "${agentId}" not found in config`,
      };
    }

    const topicKey = `shared:${agentId}`;
    const projectDir = join(this.agentsDir, agentId);

    try {
      const output = await this.processManager.sendMessage(topicKey, projectDir, prompt);
      return { agentId, agentName: agentCfg.name, output, success: true };
    } catch (err: any) {
      return {
        agentId,
        agentName: agentCfg.name,
        output: "",
        success: false,
        error: err.message,
      };
    }
  }

  getAgent(agentId: string): AgentConfig | undefined {
    return this.config.agents.find((a) => a.id === agentId);
  }

  getAllAgentIds(): string[] {
    return this.config.agents.map((a) => a.id);
  }

  shutdown(): void {
    this.processManager.shutdown();
  }
}
