import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface HistoryEntry {
  timestamp: string;
  role: "user" | "agent";
  agentName?: string;
  content: string;
}

export class ChatHistory {
  constructor(private readonly filePath: string) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(filePath)) writeFileSync(filePath, "# Shared Chat History\n\n", "utf-8");
  }

  append(entry: HistoryEntry): void {
    const prefix =
      entry.role === "user"
        ? `**[User] ${entry.timestamp}**`
        : `**[${entry.agentName}] ${entry.timestamp}**`;
    const block = `${prefix}\n\n${entry.content.trim()}\n\n---\n\n`;
    appendFileSync(this.filePath, block, "utf-8");
  }

  read(): string {
    return readFileSync(this.filePath, "utf-8");
  }

  getFilePath(): string {
    return this.filePath;
  }
}
