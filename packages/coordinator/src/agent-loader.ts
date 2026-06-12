import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";

import type { AgentDefinition } from "./index.js";

/**
 * 用户/插件 agent 定义加载器（移植自 Python coordinator/agent_definitions.py
 * 的 load_agents_dir 段）。
 *
 * `.md` 文件 = YAML frontmatter（约 20 个字段，驼峰/下划线双形态容错）+
 * 正文作 system prompt。YAML 解析失败回退行级 `key: value`（对齐 Python）。
 * 非法枚举值静默丢弃（Python 是 logger.debug）；坏文件跳过不拖垮整体。
 */

// 枚举白名单（对齐 Python 常量）
export const AGENT_COLORS: ReadonlySet<string> = new Set([
  "red", "green", "blue", "yellow", "purple", "orange", "cyan", "magenta", "white", "gray",
]);
export const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high"]);
export const PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default", "acceptEdits", "bypassPermissions", "plan", "dontAsk",
]);
export const MEMORY_SCOPES: ReadonlySet<string> = new Set(["user", "project", "local"]);
export const ISOLATION_MODES: ReadonlySet<string> = new Set(["worktree", "remote"]);

// ---------------------------------------------------------------------------
// frontmatter 解析
// ---------------------------------------------------------------------------

export function parseAgentFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0]!.trim() !== "---") {
    return { frontmatter: {}, body: content };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return { frontmatter: {}, body: content };

  const fmText = lines.slice(1, endIndex).join("\n");
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(fmText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // 回退行级 key: value（剥引号），对齐 Python 的 YAMLError fallback。
    for (const line of lines.slice(1, endIndex)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key) frontmatter[key] = value;
    }
  }

  const body = lines.slice(endIndex + 1).join("\n").trim();
  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// 字段解析助手
// ---------------------------------------------------------------------------

/** 逗号分隔字符串或列表 → string[]；空返回 undefined。 */
function parseStrList(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const items = raw.map((item) => String(item).trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof raw === "string") {
    const items = raw.split(",").map((t) => t.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const val = Number(raw);
  return Number.isInteger(val) && val > 0 ? val : undefined;
}

function pickEnum(raw: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof raw === "string" && allowed.has(raw) ? raw : undefined;
}

/** 驼峰优先、下划线回退取值。 */
function pick(fm: Record<string, unknown>, camel: string, snake: string): unknown {
  return fm[camel] !== undefined ? fm[camel] : fm[snake];
}

// ---------------------------------------------------------------------------
// 目录加载
// ---------------------------------------------------------------------------

export interface BuildAgentOptions {
  /** 文件名去 .md（filename 字段与 name 缺省值）。 */
  stem: string;
  baseDir: string;
  source: AgentDefinition["source"];
  /** 覆盖最终 agent 名（插件用 `plugin:ns:base` 命名时传入）。 */
  nameOverride?: string;
  /** description 缺省文案（缺省 `Agent: <name>`；插件传 `Agent from X plugin`）。 */
  descriptionFallback?: string;
}

/** 从已解析的 frontmatter+body 构造 AgentDefinition（loadAgentsDir 与插件侧共用）。 */
export function buildAgentDefinition(
  fm: Record<string, unknown>,
  body: string,
  options: BuildAgentOptions,
): AgentDefinition {
  const baseName = (typeof fm.name === "string" && fm.name.trim()) || options.stem;
  const name = options.nameOverride ?? baseName;
  const description =
    ((typeof fm.description === "string" && fm.description.trim()) ||
      options.descriptionFallback ||
      `Agent: ${name}`)
      .replace(/\\n/g, "\n");

  const bgRaw = fm.background;
  const ocmRaw = pick(fm, "omitClaudeMd", "omit_claude_md");
  const ipRaw = pick(fm, "initialPrompt", "initial_prompt");
  const csrRaw = pick(fm, "criticalSystemReminder", "critical_system_reminder");
  const permsRaw = fm.permissions;

  const modelRaw = fm.model;
  let model: string | undefined;
  if (typeof modelRaw === "string" && modelRaw.trim()) {
    const trimmed = modelRaw.trim();
    model = trimmed.toLowerCase() === "inherit" ? "inherit" : trimmed;
  }

  let effort: string | number | undefined;
  const effortRaw = fm.effort;
  if (typeof effortRaw === "number") {
    effort = Number.isInteger(effortRaw) && effortRaw > 0 ? effortRaw : undefined;
  } else {
    effort = pickEnum(effortRaw, EFFORT_LEVELS);
  }

  const mcpRaw = pick(fm, "mcpServers", "mcp_servers");
  const mcpServers = Array.isArray(mcpRaw) && mcpRaw.length > 0 ? mcpRaw : undefined;

  const hooksRaw = fm.hooks;
  const hooks =
    hooksRaw && typeof hooksRaw === "object" && !Array.isArray(hooksRaw)
      ? (hooksRaw as Record<string, unknown>)
      : undefined;

  return {
    name,
    description,
    systemPrompt: body || undefined,
    tools: parseStrList(fm.tools),
    disallowedTools: parseStrList(pick(fm, "disallowedTools", "disallowed_tools")),
    model,
    effort,
    permissionMode: pickEnum(pick(fm, "permissionMode", "permission_mode"), PERMISSION_MODES),
    maxTurns: parsePositiveInt(pick(fm, "maxTurns", "max_turns")),
    skills: parseStrList(fm.skills) ?? [],
    mcpServers,
    hooks,
    color: pickEnum(fm.color, AGENT_COLORS),
    background: bgRaw === true || bgRaw === "true",
    initialPrompt: typeof ipRaw === "string" && ipRaw.trim() ? ipRaw : undefined,
    memory: pickEnum(fm.memory, MEMORY_SCOPES),
    isolation: pickEnum(fm.isolation, ISOLATION_MODES),
    omitClaudeMd: ocmRaw === true || ocmRaw === "true",
    criticalSystemReminder: typeof csrRaw === "string" && csrRaw.trim() ? csrRaw : undefined,
    requiredMcpServers: parseStrList(pick(fm, "requiredMcpServers", "required_mcp_servers")),
    permissions: permsRaw
      ? String(permsRaw).split(",").map((p) => p.trim()).filter(Boolean)
      : [],
    filename: options.stem,
    baseDir: options.baseDir,
    subagentType: typeof fm.subagent_type === "string" ? fm.subagent_type : name,
    source: options.source,
  };
}

export function loadAgentsDir(
  directory: string,
  source: AgentDefinition["source"] = "user",
): AgentDefinition[] {
  if (!existsSync(directory)) return [];

  const agents: AgentDefinition[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }

  for (const file of entries) {
    try {
      const content = readFileSync(join(directory, file), "utf-8");
      const { frontmatter, body } = parseAgentFrontmatter(content);
      agents.push(
        buildAgentDefinition(frontmatter, body, {
          stem: basename(file, ".md"),
          baseDir: directory,
          source,
        }),
      );
    } catch {
      continue; // 坏文件跳过
    }
  }
  return agents;
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

/** 三源合并，同名后者覆盖：builtin < user < plugin（对齐 Python merge order）。 */
export function mergeAgentDefinitions(
  builtin: AgentDefinition[],
  user: AgentDefinition[],
  plugin: AgentDefinition[],
): AgentDefinition[] {
  const map = new Map<string, AgentDefinition>();
  for (const agent of [...builtin, ...user, ...plugin]) {
    map.set(agent.name, agent);
  }
  return [...map.values()];
}
