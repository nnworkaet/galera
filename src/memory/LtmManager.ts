import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface LtmEntry {
  file: string;
  anchor: string;
  description: string;
  keywords: string[];
  updated: string;
}

const TABLE_HEADER = `| File#Anchor | Description | Keywords | Updated |\n|---|---|---|---|`;

export class LtmManager {
  private ltmDir: string;
  private indexPath: string;

  constructor(ltmDir: string) {
    this.ltmDir = ltmDir;
    this.indexPath = join(ltmDir, "_index.md");
    mkdirSync(ltmDir, { recursive: true });
    this.ensureIndex();
  }

  getSection(file: string, anchor: string): string {
    const filePath = join(this.ltmDir, file);
    if (!existsSync(filePath)) return "";
    const content = readFileSync(filePath, "utf-8");
    const marker = `## #${anchor}`;
    const start = content.indexOf(marker);
    if (start === -1) return "";
    const end = content.indexOf("\n## ", start + 1);
    return end === -1 ? content.slice(start) : content.slice(start, end);
  }

  getFile(file: string): string {
    const filePath = join(this.ltmDir, file);
    if (!existsSync(filePath)) return "";
    return readFileSync(filePath, "utf-8");
  }

  getIndex(): string {
    if (!existsSync(this.indexPath)) return "";
    return readFileSync(this.indexPath, "utf-8");
  }

  listEntries(): LtmEntry[] {
    const index = this.getIndex();
    const entries: LtmEntry[] = [];
    for (const line of index.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|") || trimmed.startsWith("| File") || trimmed.startsWith("|---")) continue;
      const cols = trimmed.split("|").map((c) => c.trim()).filter((c) => c !== "");
      if (cols.length < 4) continue;
      const fileAnchor = cols[0];
      const hashIdx = fileAnchor.indexOf("#");
      const file = hashIdx === -1 ? fileAnchor : fileAnchor.slice(0, hashIdx);
      const anchor = hashIdx === -1 ? "" : fileAnchor.slice(hashIdx + 1);
      entries.push({
        file,
        anchor,
        description: cols[1],
        keywords: cols[2].split(",").map((k) => k.trim()).filter(Boolean),
        updated: cols[3],
      });
    }
    return entries;
  }

  search(query: string): Array<{ entry: LtmEntry; section: string }> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];

    const entries = this.listEntries();
    const results: Array<{ entry: LtmEntry; section: string; score: number }> = [];

    for (const entry of entries) {
      const haystack = [
        entry.file,
        entry.anchor,
        entry.description,
        ...entry.keywords,
      ].join(" ").toLowerCase();

      const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
      if (score === 0) continue;

      const section = entry.anchor
        ? this.getSection(entry.file, entry.anchor)
        : this.getFile(entry.file);

      results.push({ entry, section, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.map(({ entry, section }) => ({ entry, section }));
  }

  appendSection(file: string, anchor: string, tags: string[], content: string): void {
    const filePath = join(this.ltmDir, file);
    const section = `## #${anchor}\n_tags: ${tags.join(", ")}_\n\n${content.trim()}\n`;

    if (!existsSync(filePath)) {
      const heading = `# ${file.replace(/\.md$/, "")}\n\n`;
      writeFileSync(filePath, heading + section, "utf-8");
      return;
    }

    const existing = readFileSync(filePath, "utf-8");
    const marker = `## #${anchor}`;
    const start = existing.indexOf(marker);

    if (start === -1) {
      writeFileSync(filePath, existing.trimEnd() + "\n\n" + section, "utf-8");
    } else {
      const end = existing.indexOf("\n## ", start + 1);
      const before = existing.slice(0, start);
      const after = end === -1 ? "" : existing.slice(end);
      writeFileSync(filePath, before + section + after, "utf-8");
    }
  }

  updateIndex(file: string, anchor: string, description: string, keywords: string[]): void {
    const fileAnchor = anchor ? `${file}#${anchor}` : file;
    const date = new Date().toISOString().slice(0, 10);
    const newRow = `| ${fileAnchor} | ${description} | ${keywords.join(", ")} | ${date} |`;

    const index = this.getIndex();
    const lines = index.split("\n");
    const existingIdx = lines.findIndex((l) => {
      const col = l.split("|")[1]?.trim();
      return col === fileAnchor;
    });

    if (existingIdx !== -1) {
      lines[existingIdx] = newRow;
      writeFileSync(this.indexPath, lines.join("\n"), "utf-8");
    } else {
      const trimmed = index.trimEnd();
      writeFileSync(this.indexPath, trimmed + "\n" + newRow + "\n", "utf-8");
    }
  }

  deleteSection(file: string, anchor: string): boolean {
    const filePath = join(this.ltmDir, file);
    if (!existsSync(filePath)) return false;

    const content = readFileSync(filePath, "utf-8");
    const marker = `## #${anchor}`;
    const start = content.indexOf(marker);
    if (start === -1) return false;

    const end = content.indexOf("\n## ", start + 1);
    const updated = end === -1
      ? content.slice(0, start).trimEnd() + "\n"
      : content.slice(0, start) + content.slice(end + 1);

    writeFileSync(filePath, updated, "utf-8");
    this.removeFromIndex(file, anchor);
    return true;
  }

  private removeFromIndex(file: string, anchor: string): void {
    const fileAnchor = anchor ? `${file}#${anchor}` : file;
    const index = this.getIndex();
    const lines = index.split("\n").filter((l) => {
      const col = l.split("|")[1]?.trim();
      return col !== fileAnchor;
    });
    writeFileSync(this.indexPath, lines.join("\n"), "utf-8");
  }

  private ensureIndex(): void {
    if (existsSync(this.indexPath)) return;
    const content = [
      "# LTM Index",
      "",
      "This file is auto-maintained. Each row points to a section in an LTM file.",
      "",
      TABLE_HEADER,
    ].join("\n") + "\n";
    writeFileSync(this.indexPath, content, "utf-8");
  }
}
