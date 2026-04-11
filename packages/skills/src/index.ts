import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  path: string;
  source?: "bundled" | "user" | "plugin";
  metadata?: Record<string, unknown>;
}

export interface SkillLoadOptions {
  paths: string[];
  recursive?: boolean;
}

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  getAll(): readonly SkillDefinition[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  unregister(name: string): void {
    this.skills.delete(name);
  }

  resolveContent(name: string): string | undefined {
    const skill = this.skills.get(name);
    return skill?.content;
  }
}

export interface ParsedSkillMeta {
  name: string;
  description: string;
}

export function parseSkillMarkdown(
  defaultName: string,
  content: string
): ParsedSkillMeta {
  let name = defaultName;
  let description = "";
  let bodyStart = 0;

  if (content.startsWith("---\n")) {
    const lines = content.split("\n");
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        endIdx = i;
        break;
      }
    }
    if (endIdx > 0) {
      for (let i = 1; i < endIdx; i++) {
        const line = lines[i]!;
        if (line.startsWith("name:")) {
          const val = line.slice(5).trim().replace(/^['"]|['"]$/g, "");
          if (val) name = val;
        } else if (line.startsWith("description:")) {
          const val = line.slice(12).trim().replace(/^['"]|['"]$/g, "");
          if (val) description = val;
        }
      }
      if (description) return { name, description };
      bodyStart = endIdx + 1;
    }
  }

  const lines = content.split("\n").slice(bodyStart);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ") && (name === defaultName || !name)) {
      name = trimmed.slice(2).trim() || name;
      continue;
    }
    if (trimmed.startsWith("---") || trimmed.startsWith("#") || trimmed === "") {
      continue;
    }
    description = trimmed.slice(0, 200);
    break;
  }

  if (!description) description = `Skill: ${name}`;
  return { name, description };
}

export class SkillLoader {
  private registry: SkillRegistry;

  constructor(registry: SkillRegistry) {
    this.registry = registry;
  }

  async loadFromMarkdown(filePath: string): Promise<SkillDefinition | undefined> {
    const content = await this.readFile(filePath);
    if (!content) return undefined;

    const skill = this.parseMarkdown(filePath, content);
    if (skill) {
      this.registry.register(skill);
    }
    return skill;
  }

  async loadFromDirectory(
    dirPath: string,
    recursive?: boolean
  ): Promise<SkillDefinition[]> {
    const files = await this.discoverMarkdownFiles(dirPath, recursive);
    const skills: SkillDefinition[] = [];
    for (const file of files) {
      const skill = await this.loadFromMarkdown(file);
      if (skill) skills.push(skill);
    }
    return skills;
  }

  private parseMarkdown(
    filePath: string,
    content: string
  ): SkillDefinition {
    const defaultName = this.pathToName(filePath);
    const { name, description } = parseSkillMarkdown(defaultName, content);
    return { name, description, content, path: filePath };
  }

  private pathToName(filePath: string): string {
    return basename(filePath, ".md");
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return undefined;
    }
  }

  async discoverMarkdownFiles(
    dirPath: string,
    recursive?: boolean
  ): Promise<string[]> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dirPath, entry.name);
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(full);
        } else if (recursive && entry.isDirectory()) {
          files.push(...await this.discoverMarkdownFiles(full, true));
        }
      }
      return files.sort();
    } catch {
      return [];
    }
  }
}
