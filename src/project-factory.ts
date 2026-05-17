import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "fs";
import { resolve, join } from "path";
import { type Settings, type TopicMapping, type AgentConfig, getTemplatesDir } from "./config";

export class ProjectFactory {
  private settings: Settings;
  private templatesDir: string;

  constructor(settings: Settings) {
    this.settings = settings;
    this.templatesDir = getTemplatesDir();
  }

  /**
   * Create a new project directory for a Telegram topic.
   */
  createProject(topicName: string, groupId: string, topicId: string, firstMessage: string): TopicMapping {
    const slug = this.slugify(topicName);
    const projectPath = resolve(this.settings.projectsRoot, slug);

    // Don't overwrite existing projects
    if (existsSync(projectPath)) {
      console.log(`[ProjectFactory] Project already exists: ${projectPath}`);
      return this.existingProjectMapping(projectPath, topicName);
    }

    console.log(`[ProjectFactory] Creating project: ${projectPath}`);

    // Create project directory
    mkdirSync(projectPath, { recursive: true });

    // Copy SOUL.md
    const soulSrc = resolve(this.templatesDir, "SOUL.md");
    if (existsSync(soulSrc)) {
      copyFileSync(soulSrc, join(projectPath, "SOUL.md"));
    }

    // Create symlink or copy main-memory.md (shared across projects)
    const mainMemorySrc = resolve(this.templatesDir, "main-memory.md");
    const mainMemoryDst = join(projectPath, "main-memory.md");
    if (existsSync(mainMemorySrc)) {
      try {
        symlinkSync(mainMemorySrc, mainMemoryDst);
      } catch {
        // Symlinks may fail on Windows without admin — fallback to copy
        copyFileSync(mainMemorySrc, mainMemoryDst);
      }
    }

    // Create CLAUDE.md from template
    const claudeTemplate = readFileSync(resolve(this.templatesDir, "CLAUDE.md"), "utf-8");
    const claudeMd = claudeTemplate
      .replace("{{PROJECT_NAME}}", topicName)
      .replace("{{TOPIC_NAME}}", topicName)
      .replace("{{CREATED_DATE}}", new Date().toISOString().split("T")[0]);
    writeFileSync(join(projectPath, "CLAUDE.md"), claudeMd, "utf-8");

    // Create topic-specific memory
    const topicMemory = `# ${topicName}\n\nПамять проекта. Создан из Telegram-топика.\n\n## Контекст создания\nПервое сообщение: ${firstMessage}\nДата: ${new Date().toISOString()}\nГруппа: ${groupId}\nТопик: ${topicId}\n`;
    writeFileSync(join(projectPath, "topic-memory.md"), topicMemory, "utf-8");

    const mapping: TopicMapping = {
      name: topicName,
      project: projectPath,
      memory: ["SOUL.md", "main-memory.md", "topic-memory.md"],
      created: new Date().toISOString(),
    };

    console.log(`[ProjectFactory] Project created: ${projectPath}`);
    return mapping;
  }

  private existingProjectMapping(projectPath: string, topicName: string): TopicMapping {
    return {
      name: topicName,
      project: projectPath,
      memory: ["SOUL.md", "main-memory.md", "topic-memory.md"],
      created: new Date().toISOString(),
    };
  }

  /**
   * Create a project directory for a shared-chat agent.
   * CLAUDE.md is always regenerated (config may change); topic-memory.md is preserved.
   */
  createSharedAgentProject(agent: AgentConfig, agentsDir: string, historyFilePath: string, allAgentIds: string[]): void {
    const projectDir = join(agentsDir, agent.id);
    mkdirSync(projectDir, { recursive: true });

    // SOUL.md — from agent config (always overwrite)
    writeFileSync(join(projectDir, "SOUL.md"), agent.soul + "\n", "utf-8");

    // topic-memory.md — only if not exists (preserve across restarts)
    const memPath = join(projectDir, "topic-memory.md");
    if (!existsSync(memPath)) {
      writeFileSync(memPath, `# ${agent.name} Memory\n\nЛичная память агента ${agent.name}.\n`, "utf-8");
    }

    // CLAUDE.md — always regenerate so SSH creds / delegation list stay current
    const claudeMd = this.buildSharedAgentClaudeMd(agent, historyFilePath, allAgentIds);
    writeFileSync(join(projectDir, "CLAUDE.md"), claudeMd, "utf-8");

    console.log(`[ProjectFactory] Shared agent project ready: ${projectDir}`);
  }

  private buildSharedAgentClaudeMd(agent: AgentConfig, historyFilePath: string, allAgentIds: string[]): string {
    const lines: string[] = [
      `# ${agent.name} — Operating Instructions`,
      ``,
      `## Role`,
      agent.soul,
      ``,
      `## System Prompt`,
      agent.systemPrompt,
      ``,
      `## Shared History`,
      `The full conversation history is at: ${historyFilePath}`,
      `ALWAYS read it with the Read tool before responding to understand the full context.`,
      ``,
    ];

    if (agent.vps) {
      lines.push(
        `## SSH / VPS Access`,
        `You have SSH access to the production server.`,
        `- Host: ${agent.vps.host}`,
        `- User: ${agent.vps.user}`,
        `- Key: ${agent.vps.keyPath}`,
        `- Command pattern: ssh -i ${agent.vps.keyPath} -o StrictHostKeyChecking=no ${agent.vps.user}@${agent.vps.host} "<command>"`,
        `- For multi-line scripts: ssh -i ${agent.vps.keyPath} -o StrictHostKeyChecking=no ${agent.vps.user}@${agent.vps.host} 'bash -s' < local-script.sh`,
        `- Always use non-interactive SSH (no TTY, pass commands as arguments).`,
        ``
      );
    }

    if (agent.alwaysActive) {
      const delegatableIds = allAgentIds.filter((id) => id !== agent.id).join(", ");
      lines.push(
        `## Delegation`,
        `To involve another agent, include lines formatted EXACTLY as:`,
        `DELEGATE: <agent-id> TASK: <task description>`,
        `You may emit multiple DELEGATE lines in one response.`,
        `Available agent IDs: ${delegatableIds}`,
        ``
      );
    }

    lines.push(
      `## Response Termination`,
      `End every response with a line containing only the word: DONE`
    );

    return lines.join("\n");
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[а-яё]/gi, (char) => {
        const map: Record<string, string> = {
          а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh",
          з: "z", и: "i", й: "j", к: "k", л: "l", м: "m", н: "n", о: "o",
          п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
          ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
          я: "ya",
        };
        return map[char.toLowerCase()] || char;
      })
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);
  }
}
