export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  path: string;
  metadata?: Record<string, unknown>;
}

export interface SkillLoadOptions {
  paths: string[];
  recursive?: boolean;
}

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill already registered: ${skill.name}`);
    }
    this.skills.set(skill.name, skill);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  getAll(): readonly SkillDefinition[] {
    return [...this.skills.values()];
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
    const name = this.extractName(content) ?? this.pathToName(filePath);
    const description = this.extractDescription(content) ?? "";
    return { name, description, content, path: filePath };
  }

  private extractName(content: string): string | undefined {
    const match = content.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim();
  }

  private extractDescription(content: string): string | undefined {
    const match = content.match(/^#\s+.+\n+\n*(.+)$/m);
    return match?.[1]?.trim();
  }

  private pathToName(filePath: string): string {
    const parts = filePath.replace(/\\/g, "/").split("/");
    const file = parts.at(-1) ?? "unknown";
    return file.replace(/\.md$/, "");
  }

  private async readFile(_path: string): Promise<string | undefined> {
    return undefined;
  }

  private async discoverMarkdownFiles(
    _dirPath: string,
    _recursive?: boolean
  ): Promise<string[]> {
    return [];
  }
}
