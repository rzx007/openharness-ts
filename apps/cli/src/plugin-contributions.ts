import { SkillRegistry, type SkillDefinition } from "@openharness/skills";
import {
  loadPlugins,
  type LoadedPlugin,
  type PluginCommandDefinition,
  type PluginDiscoverySettings,
} from "@openharness/plugins";

/**
 * 插件贡献 → 运行时注册（C.1 接线）。
 *
 * 插件的 skills 与 commands 都注册进 SkillRegistry：斜杠路由
 * （matchUserInvocableSkill）、命令列表（buildHostCommandList）、模型可见性
 * （modelVisibleList）全部复用既有 skill 链路——`/my-plugin:lint` 即时可用，
 * 无需另建插件命令表。
 *
 * 优先级：调用方在 registerBundled 之后、user/project 目录之前调用本函数，
 * 得到 bundled < plugin < user < project（register 覆盖语义，后注册者胜）。
 */

/** 插件命令在 SkillDefinition 形状上的投影（commandName=全名 plugin:ns:cmd）。 */
export function pluginCommandToSkill(command: PluginCommandDefinition): SkillDefinition {
  return {
    name: command.name,
    description: command.description,
    content: command.content,
    path: command.path ?? "",
    source: "plugin",
    userInvocable: command.userInvocable,
    disableModelInvocation: command.disableModelInvocation,
    model: command.model,
    argumentHint: command.argumentHint,
    commandName: command.name,
    displayName: command.displayName,
  };
}

/**
 * 发现并加载插件，把 enabled 插件的 skills/commands 注册进 registry。
 * 返回完整插件列表（含 disabled，供 /plugin 展示）与信任门控告警。
 */
export async function loadPluginContributions(
  skillRegistry: SkillRegistry,
  settings: PluginDiscoverySettings,
  cwd: string,
): Promise<{ plugins: LoadedPlugin[]; warnings: string[] }> {
  const { plugins, warnings } = await loadPlugins(settings, cwd);
  loadedPluginsCache = plugins;
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    for (const skill of plugin.skills) {
      skillRegistry.register(skill);
    }
    for (const command of plugin.commands) {
      skillRegistry.register(pluginCommandToSkill(command));
    }
  }
  return { plugins, warnings };
}

// ---------------------------------------------------------------------------
// hooks / MCP（bootstrap 之后才有 HookExecutor / connectAll，故经缓存二段接线）
// ---------------------------------------------------------------------------

let loadedPluginsCache: LoadedPlugin[] = [];

/** 最近一次 loadPluginContributions 的插件列表（同进程缓存）。 */
export function getLoadedPlugins(): readonly LoadedPlugin[] {
  return loadedPluginsCache;
}

/** 把 enabled 插件的 hooks 注册进执行器（bundle.hookExecutor），返回注册数。 */
export function registerPluginHooks(executor: {
  register(hook: LoadedPlugin["hooks"][number]): void;
}): number {
  let count = 0;
  for (const plugin of loadedPluginsCache) {
    if (!plugin.enabled) continue;
    for (const hook of plugin.hooks) {
      executor.register(hook);
      count += 1;
    }
  }
  return count;
}

/** 插件 MCP server 合并进用户配置：**用户 settings 同名优先**，插件不覆盖。 */
export function mergePluginMcpServers<T>(userServers: Record<string, T> | undefined): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const plugin of loadedPluginsCache) {
    if (!plugin.enabled) continue;
    for (const [name, config] of Object.entries(plugin.mcpServers)) {
      merged[name] = config as T;
    }
  }
  return { ...merged, ...(userServers ?? {}) };
}
