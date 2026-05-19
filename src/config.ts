import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface VpsConfig {
  host: string;
  user: string;
  keyPath: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  alwaysActive: boolean;
  soul: string;
  systemPrompt: string;
  vps: VpsConfig | null;
}

export interface SharedChatConfig {
  enabled: boolean;
  topicId: number;
  historyFile: string;
  agentsDir: string;
  agents: AgentConfig[];
}

export type Lang = "ru" | "en";

export interface Settings {
  language?: Lang;
  telegram: {
    allowedUsers: number[];
  };
  processes: {
    ttlMinutes: number;
    maxConcurrent: number;
    claudePath: string;
    defaultFlags: string[];
    timeoutMinutes?: number;
  };
  compaction: {
    reserveTokens: number;
    keepRecentTokens: number;
    enabled: boolean;
  };
  memory: {
    revisionIntervalMinutes: number;
    maxFileLines: number;
    deduplication: boolean;
    enabled: boolean;
  };
  projectsRoot: string;
  templatesDir: string;
  whisper: {
    enabled: boolean;
    url: string;
    language: string;
  };
  sharedChat?: SharedChatConfig;
  multiAgent?: {
    groupChatId: number;
    generalTopicId: number;
    maxChainLength?: number;
    agentCooldownSec?: number;
    maxMessagesPerTurn?: number;
    tokenTimeoutSec?: number;
    historyCompressLines?: number;
  };
  usageLimits?: {
    dailyTokens?: number;
    weeklyTokens?: number;
  };
}

export interface TopicMapping {
  name: string;
  project: string;
  sessionId?: string;
  memory: string[];
  created: string;
}

export interface TopicsConfig {
  groups: Record<string, { name: string; enabled: boolean }>;
  topics: Record<string, TopicMapping>;
}

export function loadSettings(): Settings {
  const path = resolve(ROOT, "config/settings.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function loadTopics(): TopicsConfig {
  const path = resolve(ROOT, "config/topics.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveTopics(config: TopicsConfig): void {
  const path = resolve(ROOT, "config/topics.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

export function getTemplatesDir(): string {
  return resolve(ROOT, "templates");
}

export function getSharedChatConfig(settings: Settings): SharedChatConfig | null {
  const cfg = settings.sharedChat;
  if (!cfg?.enabled) return null;
  if (!cfg.topicId) throw new Error("sharedChat.topicId is required");
  if (!cfg.agents?.length) throw new Error("sharedChat.agents must not be empty");
  const orchestrators = cfg.agents.filter(a => a.alwaysActive);
  if (orchestrators.length !== 1) throw new Error("Exactly one alwaysActive agent (orchestrator) is required in sharedChat.agents");
  return cfg;
}

export function getBotToken(): string {
  const envPath = resolve(ROOT, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/TELEGRAM_BOT_TOKEN=(.+)/);
    if (match) return match[1].trim();
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set. Create .env file or set env variable.");
  return token;
}
