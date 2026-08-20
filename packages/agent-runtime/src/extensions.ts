import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { AgentDefinition } from "@openharness/coordinator";
import type {
  IHookExecutor,
  McpServerConfig,
  Settings,
  ToolDefinition,
  IToolRegistry,
} from "@openharness/core";
import { getSkillsDir } from "@openharness/core";
import { loadPlugins, type LoadedPlugin } from "@openharness/plugins";
import { SkillLoader, SkillRegistry, findProjectSkillDirs } from "@openharness/skills";

export interface OpenHarnessExtensionContext {
  cwd: string;
  settings: Settings;
  skillRegistry: SkillRegistry;
  toolRegistry: IToolRegistry;
  hookExecutor: IHookExecutor;
}

export interface OpenHarnessAgentExtension {
  setup(context: OpenHarnessExtensionContext): Promise<void> | void;
}

export interface OpenHarnessExtensionDiscovery {
  skillRegistry: SkillRegistry;
  plugins: LoadedPlugin[];
  agentDefinitions: AgentDefinition[];
  warnings: string[];
  mcpServers: Record<string, McpServerConfig>;
}

export async function discoverOpenHarnessExtensions(
  cwd: string,
  settings: Settings,
): Promise<OpenHarnessExtensionDiscovery> {
  const skillRegistry = new SkillRegistry();
  skillRegistry.registerBundled();

  const { plugins, warnings } = await loadPlugins(settings, cwd);
  const enabledPlugins = plugins.filter((plugin) => plugin.enabled);
  const agentDefinitions = enabledPlugins.flatMap((plugin) => plugin.agents);
  for (const plugin of enabledPlugins) {
    for (const skill of plugin.skills) skillRegistry.register(skill);
    for (const command of plugin.commands) {
      skillRegistry.register({
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
      });
    }
  }

  const loader = new SkillLoader(skillRegistry);
  await loader.loadFromDirectory(getSkillsDir(), { source: "user" });
  for (const directory of await findProjectSkillDirs(cwd)) {
    await loader.loadFromDirectory(directory, { source: "project" });
  }

  const pluginMcpServers: Record<string, McpServerConfig> = {};
  for (const plugin of enabledPlugins) {
    Object.assign(pluginMcpServers, plugin.mcpServers);
  }

  return {
    skillRegistry,
    plugins,
    agentDefinitions,
    warnings,
    mcpServers: { ...pluginMcpServers, ...(settings.mcpServers ?? {}) },
  };
}

export async function configureDiscoveredExtensions(
  discovery: OpenHarnessExtensionDiscovery,
  context: Pick<OpenHarnessExtensionContext, "toolRegistry" | "hookExecutor">,
): Promise<void> {
  for (const plugin of discovery.plugins) {
    if (!plugin.enabled) continue;
    for (const hook of plugin.hooks) context.hookExecutor.register(hook);
    await registerPluginTools(context.toolRegistry, plugin);
  }
}

async function registerPluginTools(toolRegistry: IToolRegistry, plugin: LoadedPlugin): Promise<void> {
  const toolsPath = join(plugin.path, plugin.manifest.tools_dir);
  if (!existsSync(toolsPath)) return;

  let entries: string[];
  try {
    entries = readdirSync(toolsPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!/\.(js|ts)$/.test(entry)) continue;
    const filePath = join(toolsPath, entry);
    try {
      const module = await import(filePath) as { default?: unknown };
      const exported = module.default;
      const tools: unknown[] = Array.isArray(exported) ? exported : exported ? [exported] : [];
      for (const candidate of tools) {
        const tool = candidate as Partial<ToolDefinition>;
        if (typeof tool.name === "string" && typeof tool.execute === "function") {
          toolRegistry.register(tool as ToolDefinition);
        }
      }
    } catch (error) {
      process.stderr.write(
        `[plugins] Failed to load tool ${filePath}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
