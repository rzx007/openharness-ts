import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { HOOK_EVENTS, type HookDefinition, type HookEvent } from "@openharness/core";
import type { PluginManifest } from "./discovery.js";

/**
 * 插件 hooks 与 MCP 贡献（移植自 Python plugins/loader.py 对应段）。
 *
 * hooks 两种格式：
 * - 平铺 `<hooks_file>`（缺省 hooks.json）：`{ "<event>": [ {type, command, ...} ] }`
 * - 结构化 `hooks/hooks.json`（Claude Code 风格，平铺缺失时回退）：
 *   `{ hooks: { "<event>": [ { matcher, hooks: [{type, command, timeout}] } ] } }`，
 *   `${CLAUDE_PLUGIN_ROOT}` 替换为插件根绝对路径。
 *
 * MCP：`<mcp_file>`（缺省 mcp.json）→ 回退 `.mcp.json`，取 `mcpServers` map。
 *
 * 事件名沿用 TS/Python 的 snake_case 集合（HOOK_EVENTS），未知事件跳过——
 * Claude Code 的 PascalCase 事件名（PreToolUse 等）与 Python 同样不做映射。
 */

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS);
const HOOK_TYPES: ReadonlySet<string> = new Set(["command", "http", "prompt", "agent"]);

type Raw = Record<string, unknown>;

async function readJson(path: string): Promise<Raw | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Raw) : null;
  } catch {
    return null;
  }
}

/** 把一条原始 hook 记录规整成 HookDefinition；非法返回 null。 */
function toHookDefinition(
  raw: unknown,
  event: HookEvent,
  pluginName: string,
  index: number,
  matcher?: string,
): HookDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Raw;
  const type = typeof data.type === "string" ? data.type : "command";
  if (!HOOK_TYPES.has(type)) return null;

  const base = {
    id: `plugin:${pluginName}:${event}:${index}`,
    event,
    enabled: true,
    timeout: typeof data.timeout === "number" ? data.timeout : undefined,
    matcher: matcher ?? (typeof data.matcher === "string" ? data.matcher : undefined),
  };

  // 四种 hook 类型字段不同；这里按 type 透传关键字段，缺关键字段视为非法。
  if (type === "command") {
    if (typeof data.command !== "string" || !data.command) return null;
    return { ...base, type: "command", command: data.command };
  }
  if (type === "http") {
    if (typeof data.url !== "string" || !data.url) return null;
    return { ...base, type: "http", url: data.url } as HookDefinition;
  }
  if (type === "prompt") {
    if (typeof data.prompt !== "string" || !data.prompt) return null;
    return { ...base, type: "prompt", prompt: data.prompt } as HookDefinition;
  }
  // agent
  if (typeof data.prompt !== "string" || !data.prompt) return null;
  return { ...base, type: "agent", prompt: data.prompt } as HookDefinition;
}

function loadFlatHooks(raw: Raw, pluginName: string): HookDefinition[] {
  const hooks: HookDefinition[] = [];
  for (const [event, entries] of Object.entries(raw)) {
    if (!HOOK_EVENT_SET.has(event) || !Array.isArray(entries)) continue;
    entries.forEach((entry, i) => {
      const hook = toHookDefinition(entry, event as HookEvent, pluginName, i);
      if (hook) hooks.push(hook);
    });
  }
  return hooks;
}

function loadStructuredHooks(raw: Raw, pluginName: string, pluginRoot: string): HookDefinition[] {
  const hooksData = (raw.hooks && typeof raw.hooks === "object" ? raw.hooks : raw) as Raw;
  const hooks: HookDefinition[] = [];
  for (const [event, entries] of Object.entries(hooksData)) {
    if (!HOOK_EVENT_SET.has(event) || !Array.isArray(entries)) continue;
    let index = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const matcher = typeof (entry as Raw).matcher === "string" ? ((entry as Raw).matcher as string) : undefined;
      const inner = Array.isArray((entry as Raw).hooks) ? ((entry as Raw).hooks as unknown[]) : [];
      for (const rawHook of inner) {
        // ${CLAUDE_PLUGIN_ROOT} → 插件根绝对路径（仅 command 字段，对齐 Python）。
        let substituted = rawHook;
        if (rawHook && typeof rawHook === "object" && typeof (rawHook as Raw).command === "string") {
          substituted = {
            ...(rawHook as Raw),
            command: ((rawHook as Raw).command as string).replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot),
          };
        }
        const hook = toHookDefinition(substituted, event as HookEvent, pluginName, index, matcher);
        if (hook) {
          hooks.push(hook);
          index += 1;
        }
      }
    }
  }
  return hooks;
}

/** 平铺优先，缺失/损坏时回退结构化格式。 */
export async function loadPluginHooks(pluginPath: string, manifest: PluginManifest): Promise<HookDefinition[]> {
  const flat = await readJson(join(pluginPath, manifest.hooks_file));
  if (flat) {
    const hooks = loadFlatHooks(flat, manifest.name);
    if (hooks.length > 0) return hooks;
  }
  const structured = await readJson(join(pluginPath, "hooks", "hooks.json"));
  if (structured) {
    return loadStructuredHooks(structured, manifest.name, pluginPath);
  }
  return [];
}

/** `<mcp_file>` → 回退 `.mcp.json`；要求 `mcpServers` key（对齐 McpJsonConfig）。 */
export async function loadPluginMcp(
  pluginPath: string,
  manifest: PluginManifest,
): Promise<Record<string, unknown>> {
  for (const file of [join(pluginPath, manifest.mcp_file), join(pluginPath, ".mcp.json")]) {
    const raw = await readJson(file);
    if (!raw) continue;
    const servers = raw.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return servers as Record<string, unknown>;
    }
  }
  return {};
}
