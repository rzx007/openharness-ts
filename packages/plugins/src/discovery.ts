import { z } from "zod";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SkillDefinition } from "@openharness/skills";
import {
  loadPluginSkills,
  loadPluginCommands,
  type PluginCommandDefinition,
} from "./contributions.js";
import { loadPluginHooks, loadPluginMcp } from "./hooks-mcp.js";
import { loadPluginAgents } from "./agents.js";
import type { AgentDefinition } from "@openharness/coordinator";
import type { HookDefinition } from "@openharness/core";

/**
 * 插件发现与加载（移植自 Python plugins/loader.py 的发现段）。
 *
 * 目录布局兼容 Claude Code 插件格式：清单在 `plugin.json` 或
 * `.claude-plugin/plugin.json`（根级优先）。
 *
 * 双源 + 信任门控：
 * - 用户插件 `~/.openharness/plugins/`：默认加载；
 * - 项目插件 `<cwd>/.openharness/plugins/`：默认**不**加载（clone 恶意仓库
 *   即中招），须 `settings.allowProjectPlugins=true`；存在但被门控时给告警。
 *
 * 与 Python 差异：发现走纯路径计算不 mkdir（避免查询留空目录）；告警以返回值
 * 数组带出（TS 侧无 logger 基建），由调用方决定怎么呈现。
 */

// ---------------------------------------------------------------------------
// 清单 schema（snake_case 对齐 Python/Claude Code，plugin.json 跨实现互通）
// ---------------------------------------------------------------------------

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().default("0.0.0"),
  description: z.string().default(""),
  enabled_by_default: z.boolean().default(true),
  skills_dir: z.string().default("skills"),
  tools_dir: z.string().default("tools"),
  hooks_file: z.string().default("hooks.json"),
  mcp_file: z.string().default("mcp.json"),
  author: z.record(z.string(), z.unknown()).optional(),
  // 三形态：单路径 / 路径数组 / { name: { source|content, ... } } 字典
  commands: z
    .union([z.string(), z.array(z.string()), z.record(z.string(), z.record(z.string(), z.unknown()))])
    .optional(),
  agents: z.union([z.string(), z.array(z.string())]).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  hooks: z.unknown().optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  enabled: boolean;
  /** 与 Python 一致：disabled 插件也加载贡献（供 /plugin 展示），注册时按 enabled 过滤。 */
  skills: SkillDefinition[];
  commands: PluginCommandDefinition[];
  hooks: HookDefinition[];
  mcpServers: Record<string, unknown>;
  agents: AgentDefinition[];
}

/** loadPlugins 需要的最小 settings 面（与 @openharness/core Settings 结构兼容）。 */
export interface PluginDiscoverySettings {
  allowProjectPlugins?: boolean;
  /** 按插件名启停，覆盖 manifest.enabled_by_default（即 Settings.plugins）。 */
  plugins?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// 路径助手（纯计算，不建目录）
// ---------------------------------------------------------------------------

export function getUserPluginsDir(): string {
  // 与 core/paths 同约定:OPENHARNESS_CONFIG_DIR 可重定向(测试隔离)。
  const base = process.env.OPENHARNESS_CONFIG_DIR ?? join(homedir(), ".openharness");
  return join(base, "plugins");
}

export function getProjectPluginsDir(cwd: string): string {
  return join(resolve(cwd), ".openharness", "plugins");
}

/** 清单路径：根级 plugin.json 优先，回退 .claude-plugin/plugin.json（Claude Code 布局）。 */
export function findManifest(pluginDir: string): string | null {
  for (const candidate of [join(pluginDir, "plugin.json"), join(pluginDir, ".claude-plugin", "plugin.json")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 发现
// ---------------------------------------------------------------------------

function listPluginDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const full = join(root, entry);
    try {
      if (statSync(full).isDirectory() && findManifest(full) !== null) dirs.push(full);
    } catch {
      continue;
    }
  }
  return dirs;
}

/**
 * 发现插件目录：用户源 + （门控的）项目源 + extraRoots，按 root 顺序、目录名
 * 排序、resolve 去重。项目源被门控但确有插件时返回告警。
 */
export function discoverPluginPaths(
  settings: PluginDiscoverySettings,
  cwd: string,
  extraRoots?: string[],
): { paths: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const roots: string[] = [getUserPluginsDir()];

  const projectDir = getProjectPluginsDir(cwd);
  if (settings.allowProjectPlugins === true) {
    roots.push(projectDir);
  } else if (listPluginDirs(projectDir).length > 0) {
    warnings.push(
      `检测到项目插件（${projectDir}），但默认禁用。信任此工作区请在 settings 设 allowProjectPlugins=true。`,
    );
  }
  for (const root of extraRoots ?? []) {
    roots.push(resolve(root));
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const dir of listPluginDirs(root)) {
      const key = resolve(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(dir);
    }
  }
  return { paths, warnings };
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

/** 加载单个插件目录；清单缺失/损坏/不合 schema 返回 null（坏插件不拖垮整体）。 */
export async function loadPlugin(
  path: string,
  enabledPlugins: Record<string, boolean>,
): Promise<LoadedPlugin | null> {
  const manifestPath = findManifest(path);
  if (manifestPath === null) return null;

  let manifest: PluginManifest;
  try {
    manifest = PluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf-8")));
  } catch {
    return null;
  }

  const enabled = enabledPlugins[manifest.name] ?? manifest.enabled_by_default;
  try {
    return {
      manifest,
      path,
      enabled,
      skills: await loadPluginSkills(path, manifest),
      commands: await loadPluginCommands(path, manifest),
      hooks: await loadPluginHooks(path, manifest),
      mcpServers: await loadPluginMcp(path, manifest),
      agents: await loadPluginAgents(path, manifest),
    };
  } catch {
    // 贡献文件不可读（EACCES/EISDIR 等）→ 整个插件跳过，
    // 坏插件不拖垮 CLI 启动（Python 此处未捕获，会整体崩，TS 改进）。
    return null;
  }
}

/** 发现 + 逐个加载（disabled 也在列表里，供 /plugin 展示；其贡献由消费方按 enabled 过滤）。 */
export async function loadPlugins(
  settings: PluginDiscoverySettings,
  cwd: string,
  extraRoots?: string[],
): Promise<{ plugins: LoadedPlugin[]; warnings: string[] }> {
  const { paths, warnings } = discoverPluginPaths(settings, cwd, extraRoots);
  const plugins: LoadedPlugin[] = [];
  for (const path of paths) {
    const plugin = await loadPlugin(path, settings.plugins ?? {});
    if (plugin !== null) plugins.push(plugin);
  }
  return { plugins, warnings };
}
