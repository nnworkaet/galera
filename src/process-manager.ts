import { spawn, execSync, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import type { Settings } from "./config";

function resolveClaudePath(configured: string): string {
  // If already an absolute path — use it as-is
  if (configured && configured !== "claude" && (configured.startsWith("/") || configured.match(/^[A-Z]:\\/i))) {
    return configured;
  }
  // Auto-detect via where (Windows) or which (Linux/Mac)
  const cmd = process.platform === "win32" ? "where claude" : "which claude";
  try {
    const found = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0];
    if (found) {
      console.log(`[ProcessManager] Claude found: ${found}`);
      return found;
    }
  } catch {}
  return configured || "claude";
}

interface ManagedProcess {
  topicKey: string;
  projectPath: string;
  process: ChildProcess | null;
  sessionId: string;
  lastActivity: number;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  pendingResolves: Array<{
    resolve: (output: string) => void;
    reject: (error: Error) => void;
  }>;
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private settings: Settings;
  private claudePath: string;
  private onCleanup?: (topicKey: string) => void;
  onTokensUsed?: (inputTokens: number, outputTokens: number) => void;

  constructor(settings: Settings) {
    this.claudePath = resolveClaudePath(settings.processes.claudePath);
    this.settings = settings;
  }

  /**
   * Register a callback to run when a process is cleaned up (TTL expired, etc.)
   */
  setCleanupCallback(callback: (topicKey: string) => void): void {
    this.onCleanup = callback;
  }

  /**
   * Send a message to a Claude Code process for a given topic.
   * Spawns a new process per message using `claude -p` with --resume for continuity.
   */
  async sendMessage(topicKey: string, projectPath: string, message: string, sessionId?: string): Promise<string> {
    // Check concurrent limit
    const activeCount = Array.from(this.processes.values()).filter(p => p.process !== null).length;
    if (activeCount >= this.settings.processes.maxConcurrent) {
      // Kill oldest idle process
      this.killOldestIdle();
    }

    const managed = this.getOrCreate(topicKey, projectPath, sessionId);
    managed.lastActivity = Date.now();
    this.resetTTL(managed);

    return this.executeCommand(managed, message);
  }

  private getOrCreate(topicKey: string, projectPath: string, sessionId?: string): ManagedProcess {
    let managed = this.processes.get(topicKey);
    if (!managed) {
      managed = {
        topicKey,
        projectPath,
        process: null,
        sessionId: sessionId || this.generateSessionId(),
        lastActivity: Date.now(),
        ttlTimer: null,
        pendingResolves: [],
      };
      this.processes.set(topicKey, managed);
    }
    return managed;
  }

  private async executeCommand(managed: ManagedProcess, message: string): Promise<string> {
    // Write message to temp file to avoid Windows command line length limits
    const tmpDir = resolve(managed.projectPath, ".tmp");
    mkdirSync(tmpDir, { recursive: true });
    const msgFile = join(tmpDir, `msg-${Date.now()}.txt`);
    writeFileSync(msgFile, message, "utf-8");

    const args: string[] = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
    ];

    // Add --continue to resume the most recent conversation in this directory
    if (managed.sessionId !== "new") {
      args.push("--continue");
    }

    // Add default flags (e.g., --dangerously-skip-permissions)
    args.push(...this.settings.processes.defaultFlags);

    // Quote path if it contains spaces (needed for Windows shell: true)
    const claudePath = this.claudePath.includes(" ")
      ? `"${this.claudePath}"`
      : this.claudePath;

    return new Promise<string>((resolvePromise, reject) => {
      let stdout = "";
      let stderr = "";

      console.log(`[ProcessManager] Spawning: ${this.claudePath} (${message.length} chars)`);

      // Remove ANTHROPIC_API_KEY so Claude Code uses Max subscription instead of paid API
      // Remove CLAUDECODE so nested Claude Code instances don't refuse to start
      const cleanEnv = { ...process.env };
      delete cleanEnv.ANTHROPIC_API_KEY;
      delete cleanEnv.CLAUDECODE;
      // Ensure git-bash is available on Windows if not already in PATH
      if (!cleanEnv.CLAUDE_CODE_GIT_BASH_PATH) {
        const gitBashPath = process.env.CLAUDE_CODE_GIT_BASH_PATH ||
          "C:\\Users\\Bebra\\PortableGit\\bin\\bash.exe";
        cleanEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
      }

      const proc = spawn(claudePath, args, {
        cwd: managed.projectPath,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });

      // Feed message via stdin
      proc.stdin?.write(message);
      proc.stdin?.end();

      managed.process = proc;

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });

      proc.on("close", (code) => {
        managed.process = null;

        // Parse stream-json: find the result event in stdout lines
        let responseText = "";
        let inputTokens = 0;
        let outputTokens = 0;
        let sessionId = "";

        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            if (event.type === "result" && event.subtype === "success") {
              responseText = event.result ?? "";
              sessionId = event.session_id ?? "";
              inputTokens = event.usage?.input_tokens ?? 0;
              outputTokens = event.usage?.output_tokens ?? 0;
            }
          } catch {}
        }

        // Fallback: raw stdout if JSON parse failed (e.g. non-json mode)
        if (!responseText && stdout.trim()) {
          responseText = stdout.trim();
        }

        if (sessionId) managed.sessionId = sessionId;

        if (inputTokens + outputTokens > 0) {
          this.onTokensUsed?.(inputTokens, outputTokens);
        }

        if (code === 0 || responseText) {
          resolvePromise(responseText);
        } else {
          reject(new Error(`Claude exited with code ${code}: ${stderr.trim()}`));
        }
      });

      proc.on("error", (err) => {
        managed.process = null;
        reject(err);
      });

      // Configurable timeout (default 20 min for long SSH/deploy tasks)
      const timeoutMs = (this.settings.processes.timeoutMinutes ?? 20) * 60 * 1000;
      setTimeout(() => {
        if (managed.process === proc) {
          proc.kill("SIGTERM");
          reject(new Error(`Claude Code process timed out (${this.settings.processes.timeoutMinutes ?? 20} min)`));
        }
      }, timeoutMs);
    });
  }

  private resetTTL(managed: ManagedProcess): void {
    if (managed.ttlTimer) {
      clearTimeout(managed.ttlTimer);
    }
    managed.ttlTimer = setTimeout(() => {
      console.log(`[ProcessManager] TTL expired for topic ${managed.topicKey}, cleaning up`);
      this.cleanup(managed.topicKey);
    }, this.settings.processes.ttlMinutes * 60 * 1000);
  }

  private cleanup(topicKey: string): void {
    const managed = this.processes.get(topicKey);
    if (!managed) return;

    if (managed.process) {
      managed.process.kill("SIGTERM");
    }
    if (managed.ttlTimer) {
      clearTimeout(managed.ttlTimer);
    }
    this.processes.delete(topicKey);
    this.onCleanup?.(topicKey);
  }

  private killOldestIdle(): void {
    let oldest: ManagedProcess | null = null;
    for (const managed of this.processes.values()) {
      if (!oldest || managed.lastActivity < oldest.lastActivity) {
        oldest = managed;
      }
    }
    if (oldest) {
      console.log(`[ProcessManager] Killing oldest idle process: ${oldest.topicKey}`);
      this.cleanup(oldest.topicKey);
    }
  }

  /**
   * Kill a specific topic's process and clean up. Returns true if was active.
   */
  killTopic(topicKey: string): boolean {
    const managed = this.processes.get(topicKey);
    if (!managed) return false;
    this.cleanup(topicKey);
    return true;
  }

  getSessionId(topicKey: string): string | undefined {
    return this.processes.get(topicKey)?.sessionId;
  }

  private generateSessionId(): string {
    return `topic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * One-shot command: no --continue, not stored in processes map.
   * Used for history compression to avoid polluting agent sessions.
   */
  async runOnce(projectPath: string, message: string): Promise<string> {
    const ephemeral: ManagedProcess = {
      topicKey: `once:${Date.now()}`,
      projectPath,
      process: null,
      sessionId: "new",
      lastActivity: Date.now(),
      ttlTimer: null,
      pendingResolves: [],
    };
    return this.executeCommand(ephemeral, message);
  }

  getActiveCount(): number {
    return this.processes.size;
  }

  shutdown(): void {
    for (const [key] of this.processes) {
      this.cleanup(key);
    }
  }
}
