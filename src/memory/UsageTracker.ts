import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Lang } from "../config";
import { useI18n } from "../i18n";

interface DayStats {
  messages: number;
  estimatedTokens: number;
}

interface UsageData {
  daily: Record<string, DayStats>;
  weekly: Record<string, DayStats>;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekKey(): string {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function dirSizeKb(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dirPath)) {
      const full = join(dirPath, entry);
      try {
        const st = statSync(full);
        if (st.isFile()) total += st.size;
      } catch {}
    }
  } catch {}
  return total / 1024;
}

function fileKb(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    return statSync(filePath).size / 1024;
  } catch {
    return 0;
  }
}

function ltmFileCount(ltmDir: string): number {
  if (!existsSync(ltmDir)) return 0;
  try {
    return readdirSync(ltmDir).filter((f) => f.endsWith(".md") && f !== "_index.md").length;
  } catch {
    return 0;
  }
}

function ltmLastUpdated(ltmDir: string): string {
  if (!existsSync(ltmDir)) return "never";
  let latest = 0;
  try {
    for (const entry of readdirSync(ltmDir)) {
      if (!entry.endsWith(".md")) continue;
      try {
        const mtime = statSync(join(ltmDir, entry)).mtimeMs;
        if (mtime > latest) latest = mtime;
      } catch {}
    }
  } catch {}
  return latest ? new Date(latest).toISOString().slice(0, 10) : "never";
}

export class UsageTracker {
  private usagePath: string;
  private data: UsageData;

  constructor(usagePath: string) {
    this.usagePath = usagePath;
    mkdirSync(dirname(usagePath), { recursive: true });
    this.data = existsSync(usagePath)
      ? JSON.parse(readFileSync(usagePath, "utf-8"))
      : { daily: {}, weekly: {} };
  }

  track(estimatedTokens: number): void {
    const day = todayKey();
    const week = weekKey();

    if (!this.data.daily[day]) this.data.daily[day] = { messages: 0, estimatedTokens: 0 };
    if (!this.data.weekly[week]) this.data.weekly[week] = { messages: 0, estimatedTokens: 0 };

    this.data.daily[day].messages += 1;
    this.data.daily[day].estimatedTokens += estimatedTokens;
    this.data.weekly[week].messages += 1;
    this.data.weekly[week].estimatedTokens += estimatedTokens;

    writeFileSync(this.usagePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  getDailyStats(): DayStats {
    return this.data.daily[todayKey()] ?? { messages: 0, estimatedTokens: 0 };
  }

  getWeeklyStats(): DayStats {
    return this.data.weekly[weekKey()] ?? { messages: 0, estimatedTokens: 0 };
  }

  getFormattedStatus(
    agents: Array<{ name: string; projectPath: string }>,
    ltmDir: string,
    lang: Lang = "ru"
  ): string {
    const t = useI18n(lang);
    const daily = this.getDailyStats();
    const weekly = this.getWeeklyStats();

    const lines: string[] = [
      t.status_system(agents.length),
      t.status_today(daily.messages, t.status_tokens(daily.estimatedTokens)),
      t.status_week(weekly.messages, t.status_tokens(weekly.estimatedTokens)),
    ];

    const ltmFiles = ltmFileCount(ltmDir);
    const ltmKb = dirSizeKb(ltmDir);
    const ltmUpdated = ltmLastUpdated(ltmDir);
    lines.push("");
    lines.push(t.status_ltm(ltmFiles, ltmKb.toFixed(1)));
    lines.push(t.status_ltm_updated(ltmUpdated));

    const agentMemoryLines: string[] = [];
    for (const { name, projectPath } of agents) {
      const topicPath = join(projectPath, "topic-memory.md");
      const kb = fileKb(topicPath);
      agentMemoryLines.push(`  ${name}: ${kb.toFixed(1)} KB`);
    }

    if (agentMemoryLines.length > 0) {
      lines.push("");
      lines.push(t.status_memory_header);
      lines.push(...agentMemoryLines);
    }

    return lines.join("\n");
  }
}
