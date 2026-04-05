import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import type { Settings } from "./config";

/**
 * Memory Manager — periodically reviews and organizes memory files.
 *
 * Responsibilities:
 * - Detect duplicate content across memory files
 * - Remove empty sections and excessive whitespace
 * - Cross-file deduplication within a project's memory/ directory
 * - Log revision statistics
 */
export class MemoryManager {
  private settings: Settings;
  private revisionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /**
   * Start periodic memory revision.
   */
  start(): void {
    if (!this.settings.memory.enabled) {
      console.log("[MemoryManager] Disabled in settings");
      return;
    }

    const intervalMs = this.settings.memory.revisionIntervalMinutes * 60 * 1000;
    console.log(`[MemoryManager] Starting revision every ${this.settings.memory.revisionIntervalMinutes} min`);

    // Run first revision after a short delay (don't block startup)
    setTimeout(() => this.runRevision(), 30_000);

    this.revisionTimer = setInterval(() => {
      this.runRevision();
    }, intervalMs);
  }

  stop(): void {
    if (this.revisionTimer) {
      clearInterval(this.revisionTimer);
      this.revisionTimer = null;
    }
  }

  /**
   * Run a full memory revision across all project directories.
   */
  async runRevision(): Promise<void> {
    console.log("[MemoryManager] Starting memory revision...");

    const projectsRoot = this.settings.projectsRoot;
    if (!existsSync(projectsRoot)) return;

    const entries = readdirSync(projectsRoot, { withFileTypes: true });
    let revisedCount = 0;
    let totalProjects = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = join(projectsRoot, entry.name);
      const topicMem = join(projectPath, "topic-memory.md");

      if (!existsSync(topicMem)) continue;
      totalProjects++;

      // Revise topic-memory.md
      const revised = this.reviseFile(topicMem);
      if (revised) revisedCount++;

      // Cross-file deduplication within memory/ directory
      if (this.settings.memory.deduplication) {
        this.crossFileDedup(projectPath);
      }
    }

    console.log(`[MemoryManager] Revision complete. ${revisedCount}/${totalProjects} files updated.`);
  }

  /**
   * Revise a single memory file:
   * - Remove duplicate lines
   * - Remove empty sections
   * - Trim excessive whitespace
   */
  private reviseFile(filePath: string): boolean {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const maxLines = this.settings.memory.maxFileLines;

    // Check if file needs revision
    if (lines.length <= maxLines && !this.hasDuplicates(lines)) {
      return false;
    }

    let revised = content;

    // Remove duplicate lines (keeping first occurrence)
    if (this.settings.memory.deduplication) {
      revised = this.deduplicateContent(revised);
    }

    // Remove empty sections (## Header followed by nothing)
    revised = this.removeEmptySections(revised);

    // Trim excessive blank lines
    revised = revised.replace(/\n{3,}/g, "\n\n");

    // Trim trailing whitespace on each line
    revised = revised.split("\n").map(l => l.trimEnd()).join("\n");

    if (revised !== content) {
      writeFileSync(filePath, revised, "utf-8");
      const newLines = revised.split("\n").length;
      console.log(`[MemoryManager] Revised: ${filePath} (${lines.length} -> ${newLines} lines)`);
      return true;
    }

    return false;
  }

  /**
   * Cross-file deduplication: find content duplicated between topic-memory.md
   * and files in memory/ subdirectories. If topic-memory repeats info that's
   * already in a shared memory file, remove it from topic-memory.
   */
  private crossFileDedup(projectPath: string): void {
    const topicMemPath = join(projectPath, "topic-memory.md");
    if (!existsSync(topicMemPath)) return;

    const topicContent = readFileSync(topicMemPath, "utf-8");
    const topicLines = topicContent.split("\n");

    // Collect all content lines from memory/ files
    const sharedContent = new Set<string>();
    const memoryDir = join(projectPath, "memory");
    if (existsSync(memoryDir)) {
      this.collectLines(memoryDir, sharedContent);
    }

    if (sharedContent.size === 0) return;

    // Remove lines from topic-memory that exist in shared memory
    const result: string[] = [];
    let removedCount = 0;
    for (const line of topicLines) {
      const trimmed = line.trim();
      // Keep headers, empty lines, short lines
      if (trimmed.startsWith("#") || trimmed === "" || trimmed === "---" || trimmed.length < 20) {
        result.push(line);
        continue;
      }
      if (sharedContent.has(trimmed)) {
        removedCount++;
        continue;
      }
      result.push(line);
    }

    if (removedCount > 0) {
      let revised = result.join("\n");
      revised = this.removeEmptySections(revised);
      revised = revised.replace(/\n{3,}/g, "\n\n");
      writeFileSync(topicMemPath, revised, "utf-8");
      console.log(`[MemoryManager] Cross-dedup: removed ${removedCount} duplicate lines from ${topicMemPath}`);
    }
  }

  /**
   * Recursively collect non-trivial content lines from .md files in a directory.
   */
  private collectLines(dir: string, target: Set<string>): void {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.collectLines(path, target);
      } else if (entry.name.endsWith(".md")) {
        const content = readFileSync(path, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length >= 20 && !trimmed.startsWith("#")) {
            target.add(trimmed);
          }
        }
      }
    }
  }

  /**
   * Check if content has duplicate non-trivial lines.
   */
  private hasDuplicates(lines: string[]): boolean {
    const seen = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 10) continue;
      if (trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("-") && trimmed.length < 20) continue;
      if (seen.has(trimmed)) return true;
      seen.add(trimmed);
    }
    return false;
  }

  /**
   * Remove duplicate content blocks while preserving structure.
   */
  private deduplicateContent(content: string): string {
    const lines = content.split("\n");
    const result: string[] = [];
    const seenContent = new Set<string>();

    for (const line of lines) {
      const trimmed = line.trim();

      // Always keep headers, empty lines, frontmatter
      if (trimmed.startsWith("#") || trimmed === "" || trimmed === "---") {
        result.push(line);
        continue;
      }

      // Skip exact duplicate non-trivial lines
      if (trimmed.length >= 10 && seenContent.has(trimmed)) {
        continue;
      }

      seenContent.add(trimmed);
      result.push(line);
    }

    return result.join("\n");
  }

  /**
   * Remove sections that have a header but no content.
   */
  private removeEmptySections(content: string): string {
    const lines = content.split("\n");
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check if this is a header followed by another header or end of file
      if (trimmed.startsWith("##") && !trimmed.startsWith("###")) {
        const nextContentLine = this.findNextContentLine(lines, i + 1);
        if (nextContentLine === null || lines[nextContentLine].trim().startsWith("##")) {
          // Empty section — skip header
          continue;
        }
      }

      result.push(line);
    }

    return result.join("\n");
  }

  /**
   * Find next non-empty line index.
   */
  private findNextContentLine(lines: string[], startIndex: number): number | null {
    for (let i = startIndex; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === "") continue;
      return i;
    }
    return null;
  }

  /**
   * Get memory stats for a project.
   */
  getStats(projectPath: string): { totalFiles: number; totalLines: number; totalSize: number } {
    let totalFiles = 0;
    let totalLines = 0;
    let totalSize = 0;

    const checkDir = (dir: string) => {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDir(path);
        } else if (entry.name.endsWith(".md")) {
          totalFiles++;
          const stat = statSync(path);
          totalSize += stat.size;
          totalLines += readFileSync(path, "utf-8").split("\n").length;
        }
      }
    };

    checkDir(projectPath);
    return { totalFiles, totalLines, totalSize };
  }
}
