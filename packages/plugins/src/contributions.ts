import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { parseSkillMarkdown, type SkillDefinition } from "@openharness/skills";
import type { PluginManifest } from "./discovery.js";

/**
 * 插件贡献加载：skills + commands（移植自 Python plugins/loader.py 的对应段）。
 *
 * - skills：`<plugin>/<skills_dir>/` 下 Claude Code 的目录式布局——根级单个
 *   SKILL.md，或每个子目录一个 SKILL.md。
 * - commands：默认 `commands/` 目录递归（目录含 SKILL.md 则整目录算一条
 *   skill 型命令、剪枝子树）+ manifest.commands 三形态（路径/路径数组/字典），
 *   命名 `<plugin>:<目录命名空间>:<名字>`，resolve 去重。
 *
 * 与 Python 差异：frontmatter 复用 @openharness/skills 的 parseSkillMarkdown
 * （不引 YAML 依赖），故不解析 when_to_use/version/effort/allowed-tools 等
 * 命令字段——TS 斜杠命令消费面用不到，留待需要时补。
 */

export interface PluginCommandDefinition {
  name: string;
  description: string;
  content: string;
  source: "plugin";
  path?: string;
  baseDir?: string;
  argumentHint?: string;
  model?: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  isSkill: boolean;
  displayName?: string;
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

async function loadSkillFromFile(skillPath: string, baseDir: string, defaultName: string): Promise<SkillDefinition> {
  const content = await readFile(skillPath, "utf-8");
  const meta = parseSkillMarkdown(defaultName, content);
  return {
    name: meta.name,
    description: meta.description,
    content,
    path: skillPath,
    source: "plugin",
    userInvocable: meta.userInvocable,
    disableModelInvocation: meta.disableModelInvocation,
    model: meta.model,
    argumentHint: meta.argumentHint,
    commandName: defaultName,
    displayName: meta.name !== defaultName ? meta.name : undefined,
    metadata: { baseDir },
  };
}

/** skills_dir 下两种布局：根级 SKILL.md（单 skill）或每子目录一个 SKILL.md。 */
export async function loadPluginSkills(pluginPath: string, manifest: PluginManifest): Promise<SkillDefinition[]> {
  const root = join(pluginPath, manifest.skills_dir);
  if (!existsSync(root)) return [];

  const direct = join(root, "SKILL.md");
  if (existsSync(direct)) {
    return [await loadSkillFromFile(direct, root, basename(root))];
  }

  const skills: SkillDefinition[] = [];
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    const skillPath = join(dir, "SKILL.md");
    try {
      if (!statSync(dir).isDirectory() || !existsSync(skillPath)) continue;
    } catch {
      continue;
    }
    skills.push(await loadSkillFromFile(skillPath, dir, entry));
  }
  return skills;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

interface CommandFileRef {
  file: string;
  /** 命名空间段（相对扫描根的目录链；SKILL.md 时最后一段是 skill 目录名）。 */
  nameParts: string[];
  isSkill: boolean;
}

/** 递归收集命令文件：目录含 SKILL.md → 整目录一条 skill 命令并剪枝。 */
function walkCommandFiles(dir: string, nameParts: string[]): CommandFileRef[] {
  const skillFile = join(dir, "SKILL.md");
  if (existsSync(skillFile)) {
    // 顶层就有 SKILL.md 时 nameParts 为空 → 用目录名兜底。
    const parts = nameParts.length > 0 ? nameParts : [basename(dir)];
    return [{ file: skillFile, nameParts: parts, isSkill: true }];
  }

  const refs: CommandFileRef[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      refs.push(...walkCommandFiles(full, [...nameParts, entry]));
    } else if (entry.toLowerCase().endsWith(".md")) {
      refs.push({ file: full, nameParts: [...nameParts, entry.replace(/\.md$/i, "")], isSkill: false });
    }
  }
  return refs;
}

function extractDescriptionFallback(body: string, fallback: string): string {
  for (const line of body.split(/\r?\n/)) {
    let stripped = line.trim();
    if (!stripped) continue;
    if (stripped.startsWith("#")) stripped = stripped.replace(/^#+\s*/, "");
    if (stripped) return stripped;
  }
  return fallback;
}

/** 去掉 frontmatter 块，返回正文。 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content.trim();
  const marker = /\r?\n---\r?\n/;
  const match = marker.exec(content.slice(3));
  if (!match) return content.trim();
  return content.slice(3 + match.index + match[0].length).trim();
}

interface CommandMetadataOverride {
  description?: string;
  argumentHint?: string;
  model?: string;
}

/**
 * frontmatter 块里是否显式写了 description。
 * parseSkillMarkdown 在无 frontmatter 时会启发式取首段当 description，
 * 而 Python 命令语义是「frontmatter 没写就取正文第一个非空行（剥 #）」——
 * 这里据此决定用谁。
 */
function frontmatterHasDescription(content: string): boolean {
  if (!/^---\r?\n/.test(content)) return false;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) return false;
  return /^\s*description\s*:/im.test(match[1]!);
}

async function loadCommandFile(
  filePath: string,
  commandName: string,
  override: CommandMetadataOverride | null,
  isSkill: boolean,
  seen: Set<string>,
): Promise<PluginCommandDefinition | null> {
  if (!existsSync(filePath)) return null;
  const key = resolve(filePath);
  if (seen.has(key)) return null;
  seen.add(key);

  const content = await readFile(filePath, "utf-8");
  const defaultName = basename(filePath).replace(/\.md$/i, "");
  const meta = parseSkillMarkdown(defaultName, content);
  const body = stripFrontmatter(content);

  const description =
    override?.description?.trim() ||
    (frontmatterHasDescription(content) ? meta.description : "") ||
    extractDescriptionFallback(body, `Plugin command from ${commandName}`);

  return {
    name: commandName,
    description,
    content: body,
    source: "plugin",
    path: filePath,
    baseDir: join(filePath, ".."),
    argumentHint: override?.argumentHint ?? meta.argumentHint,
    model: override?.model ?? meta.model,
    userInvocable: meta.userInvocable,
    disableModelInvocation: meta.disableModelInvocation,
    isSkill,
    displayName: meta.name !== defaultName ? meta.name : undefined,
  };
}

async function loadCommandsFromDirectory(
  directory: string,
  pluginName: string,
  seen: Set<string>,
): Promise<PluginCommandDefinition[]> {
  if (!existsSync(directory)) return [];
  const commands: PluginCommandDefinition[] = [];
  for (const ref of walkCommandFiles(directory, [])) {
    const name = [pluginName, ...ref.nameParts].join(":");
    const command = await loadCommandFile(ref.file, name, null, ref.isSkill, seen);
    if (command !== null) {
      if (ref.isSkill) command.baseDir = join(ref.file, "..");
      commands.push(command);
    }
  }
  return commands;
}

/** 默认 commands/ 目录 + manifest.commands 三形态，合并去重。 */
export async function loadPluginCommands(
  pluginPath: string,
  manifest: PluginManifest,
): Promise<PluginCommandDefinition[]> {
  const seen = new Set<string>();
  const commands: PluginCommandDefinition[] = [];

  commands.push(...(await loadCommandsFromDirectory(join(pluginPath, "commands"), manifest.name, seen)));

  const manifestCommands = manifest.commands;
  if (manifestCommands && typeof manifestCommands === "object" && !Array.isArray(manifestCommands)) {
    // 字典形态：{ name: { source: 路径 } } 或 { name: { content: 内联 } }
    for (const [commandName, metadata] of Object.entries(manifestCommands)) {
      const source = metadata.source;
      const content = metadata.content;
      const override: CommandMetadataOverride = {
        description: typeof metadata.description === "string" ? metadata.description : undefined,
        argumentHint: typeof metadata.argumentHint === "string" ? metadata.argumentHint : undefined,
        model: typeof metadata.model === "string" ? metadata.model : undefined,
      };
      if (typeof source === "string") {
        const commandPath = resolve(pluginPath, source);
        if (existsSync(commandPath) && statSync(commandPath).isDirectory()) {
          commands.push(...(await loadCommandsFromDirectory(commandPath, manifest.name, seen)));
        } else {
          const command = await loadCommandFile(
            commandPath,
            `${manifest.name}:${commandName}`,
            override,
            false,
            seen,
          );
          if (command !== null) commands.push(command);
        }
      } else if (typeof content === "string") {
        commands.push({
          name: `${manifest.name}:${commandName}`,
          description: override.description ?? `Plugin command from ${manifest.name}`,
          content: content.trim(),
          source: "plugin",
          argumentHint: override.argumentHint,
          model: override.model,
          userInvocable: true,
          disableModelInvocation: false,
          isSkill: false,
        });
      }
    }
  } else {
    // 字符串/数组形态：路径列表（目录或 .md 文件）
    const rawPaths = typeof manifestCommands === "string" ? [manifestCommands] : (manifestCommands ?? []);
    for (const rawPath of rawPaths) {
      const commandPath = resolve(pluginPath, rawPath);
      if (!existsSync(commandPath)) continue;
      if (statSync(commandPath).isDirectory()) {
        commands.push(...(await loadCommandsFromDirectory(commandPath, manifest.name, seen)));
      } else if (commandPath.toLowerCase().endsWith(".md")) {
        const command = await loadCommandFile(
          commandPath,
          `${manifest.name}:${basename(commandPath).replace(/\.md$/i, "")}`,
          null,
          false,
          seen,
        );
        if (command !== null) commands.push(command);
      }
    }
  }
  return commands;
}
