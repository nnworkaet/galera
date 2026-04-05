import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Settings {
  telegram: {
    allowedUsers: number[];
  };
  processes: {
    ttlMinutes: number;
    maxConcurrent: number;
    claudePath: string;
    defaultFlags: string[];
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
