import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { BUNDLED_SKILLS } from "./bundled.js";

export { BUNDLED_SKILLS } from "./bundled.js";

/**
 * 定义技能（Skill）的结构信息。
 */
export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  path: string;
  source?: "bundled" | "user" | "project" | "plugin";
  metadata?: Record<string, unknown>;
  /** 是否允许用户通过 /<name> 斜杠命令调用。缺省 true。 */
  userInvocable: boolean;
  /** 是否禁止模型在 system prompt / Skill 工具中发现并调用。缺省 false。 */
  disableModelInvocation: boolean;
  /** 可选的 model 覆盖。 */
  model?: string;
  /** 可选的参数提示（用于命令补全/帮助）。 */
  argumentHint?: string;
  /** 可选的命令名（用于斜杠命令路由，缺省用 name）。 */
  commandName?: string;
  /** 可选的展示名。 */
  displayName?: string;
}

/**
 * 加载技能时的配置选项。
 */
export interface SkillLoadOptions {
  paths: string[];
  recursive?: boolean;
}

/**
 * 技能注册表，用于管理已加载的技能定义。
 * 提供技能的注册、查询、获取列表和注销功能。
 */
export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  /**
   * 注册一个技能定义到注册表中。
   * @param skill - 要注册的技能定义对象。
   */
  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  /**
   * 注册全部内置（bundled）技能。
   *
   * 来源优先级：bundled < user < project。bundled 应**最先**注册，
   * 之后 user / project 技能用 register() 按名覆盖（后注册者赢）。
   */
  registerBundled(): void {
    for (const skill of BUNDLED_SKILLS) {
      this.register(skill);
    }
  }

  /**
   * 根据名称获取单个技能定义。
   * @param name - 技能的名称。
   * @returns 如果找到则返回技能定义，否则返回 undefined。
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /**
   * 获取所有已注册的技能定义列表，并按名称字母顺序排序。
   * @returns 只读的技能定义数组。
   */
  getAll(): readonly SkillDefinition[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 检查指定名称的技能是否已注册。
   * @param name - 技能的名称。
   * @returns 如果存在则返回 true，否则返回 false。
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * 从注册表中注销指定名称的技能。
   * @param name - 要注销的技能名称。
   */
  unregister(name: string): void {
    this.skills.delete(name);
  }

  /**
   * 解析并获取指定技能的内容字符串。
   * @param name - 技能的名称。
   * @returns 技能的内容字符串，如果技能不存在则返回 undefined。
   */
  resolveContent(name: string): string | undefined {
    const skill = this.skills.get(name);
    return skill?.content;
  }

  /**
   * 构建"给模型看"的技能列表（进 system prompt 的 skillsList 来源）：
   * 过滤掉 disableModelInvocation 为 true 的技能，使模型不会主动发现/调用它们
   * （它们仍可被用户通过 /<name> 斜杠调用）。映射成 {name, description}。
   */
  modelVisibleList(): Array<{ name: string; description: string }> {
    return this.getAll()
      .filter((s) => s.disableModelInvocation !== true)
      .map((s) => ({ name: s.name, description: s.description }));
  }
}

/**
 * 解析后的技能元数据接口。
 */
export interface ParsedSkillMeta {
  name: string;
  description: string;
  /** 缺省 true（对齐 Python user_invocable=True）。 */
  userInvocable: boolean;
  /** 缺省 false（对齐 Python disable_model_invocation=False）。 */
  disableModelInvocation: boolean;
  model?: string;
  argumentHint?: string;
  commandName?: string;
  displayName?: string;
}

/**
 * 解析 frontmatter 布尔值。true/1/yes/on → true，false/0/no/off → false。
 * 无法识别时返回 fallback。
 */
function parseFrontmatterBool(raw: string, fallback: boolean): boolean {
  const v = raw.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * 把 frontmatter 的 key 归一化：去掉连字符/下划线差异，统一小写。
 * 例如 `user-invocable` 和 `user_invocable` 都归一为 `userinvocable`。
 */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_]/g, "");
}

/**
 * 从 Markdown 内容中解析技能的名称和描述。
 * 支持 Frontmatter 格式（--- 包裹的 YAML 头部）提取元数据。
 * 如果没有 Frontmatter，则尝试从第一个标题或第一段文本中提取。
 *
 * @param defaultName - 默认的名称，通常由文件名生成，当内容中未指定名称时使用。
 * @param content - Markdown 文件的完整内容字符串。
 * @returns 包含解析后的 name 和 description 的对象。
 */
export function parseSkillMarkdown(
  defaultName: string,
  content: string
): ParsedSkillMeta {
  let name = defaultName;
  let description = "";
  let bodyStart = 0;

  // 扩展字段（带默认值，对齐 Python）
  let userInvocable = true;
  let disableModelInvocation = false;
  let model: string | undefined;
  let argumentHint: string | undefined;
  let commandName: string | undefined;
  let displayName: string | undefined;

  // 尝试解析 Frontmatter 部分
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
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = normalizeKey(line.slice(0, colon));
        const rawVal = line.slice(colon + 1).trim();
        const val = rawVal.replace(/^['"]|['"]$/g, "");
        switch (key) {
          case "name":
            if (val) name = val;
            break;
          case "description":
            if (val) description = val;
            break;
          case "userinvocable":
            userInvocable = parseFrontmatterBool(rawVal, true);
            break;
          case "disablemodelinvocation":
            disableModelInvocation = parseFrontmatterBool(rawVal, false);
            break;
          case "model":
            if (val) model = val;
            break;
          case "argumenthint":
            if (val) argumentHint = val;
            break;
          case "commandname":
            if (val) commandName = val;
            break;
          case "displayname":
            if (val) displayName = val;
            break;
        }
      }
      bodyStart = endIdx + 1;
    }
  }

  // 如果没有从 Frontmatter 获取到描述，则从正文中提取
  if (!description) {
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
  }

  if (!description) description = `Skill: ${name}`;
  return {
    name,
    description,
    userInvocable,
    disableModelInvocation,
    model,
    argumentHint,
    commandName,
    displayName,
  };
}

/**
 * 技能加载器，负责从文件系统读取 Markdown 文件并加载到注册表中。
 */
export class SkillLoader {
  private registry: SkillRegistry;

  /**
   * 创建 SkillLoader 实例。
   * @param registry - 用于注册加载后技能的 SkillRegistry 实例。
   */
  constructor(registry: SkillRegistry) {
    this.registry = registry;
  }

  /**
   * 从单个 Markdown 文件加载技能定义，并自动注册到注册表中。
   * @param filePath - Markdown 文件的路径。
   * @returns 如果加载成功则返回 SkillDefinition，否则返回 undefined。
   */
  async loadFromMarkdown(filePath: string): Promise<SkillDefinition | undefined> {
    const content = await this.readFile(filePath);
    if (!content) return undefined;

    const skill = this.parseMarkdown(filePath, content);
    if (skill) {
      this.registry.register(skill);
    }
    return skill;
  }

  /**
   * 从指定目录加载所有 Markdown 文件作为技能。
   * @param dirPath - 要扫描的目录路径。
   * @param recursive - 是否递归扫描子目录，默认为 false。
   * @returns 加载成功的技能定义数组。
   */
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

  /**
   * 解析 Markdown 内容并构建 SkillDefinition 对象。
   * @param filePath - 文件路径，用于生成默认名称。
   * @param content - 文件内容字符串。
   * @returns 构建好的 SkillDefinition 对象。
   */
  private parseMarkdown(
    filePath: string,
    content: string
  ): SkillDefinition {
    const defaultName = this.pathToName(filePath);
    const meta = parseSkillMarkdown(defaultName, content);
    return {
      name: meta.name,
      description: meta.description,
      content,
      path: filePath,
      userInvocable: meta.userInvocable,
      disableModelInvocation: meta.disableModelInvocation,
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(meta.argumentHint !== undefined ? { argumentHint: meta.argumentHint } : {}),
      ...(meta.commandName !== undefined ? { commandName: meta.commandName } : {}),
      ...(meta.displayName !== undefined ? { displayName: meta.displayName } : {}),
    };
  }

  /**
   * 从文件路径中提取不带扩展名的文件名作为默认技能名称。
   * @param filePath - 完整的文件路径。
   * @returns 去除 .md 后缀后的文件名。
   */
  private pathToName(filePath: string): string {
    return basename(filePath, ".md");
  }

  /**
   * 异步读取文件内容。
   * @param path - 文件路径。
   * @returns 文件内容的 UTF-8 字符串，如果读取失败则返回 undefined。
   */
  async readFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return undefined;
    }
  }

  /**
   * 发现指定目录下的所有 Markdown 文件。
   * @param dirPath - 要扫描的目录路径。
   * @param recursive - 是否递归扫描子目录。
   * @returns 找到的 Markdown 文件路径数组，已排序。
   */
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

/**
 * 支持的 Frontmatter 格式：
 * 
---
name: git-workflow
description: Git 工作流程指南
userInvocable: true
disableModelInvocation: false
model: claude-3-opus
argumentHint: <branch-name>
commandName: git
displayName: Git 助手
---

# 实际内容... 
 */