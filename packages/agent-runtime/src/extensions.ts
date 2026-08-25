import type { AgentDefinition } from "@openharness/coordinator";
import type { IHookExecutor, McpServerConfig, Settings, IToolRegistry } from "@openharness/core";
import { getSkillsDir } from "@openharness/core";
import {
  discoverInstalledNativePlugins,
  buildNativePluginCompatibilityEnvironment,
  loadNativePlugin,
  validateNativePlugin,
  type LoadedNativePlugin,
} from "@openharness/plugins";
import { SkillLoader, SkillRegistry, findProjectSkillDirs } from "@openharness/skills";

export interface OpenHarnessExtensionContext {
  cwd: string;
  settings: Settings;
  skillRegistry: SkillRegistry;
  toolRegistry: IToolRegistry;
  hookExecutor: IHookExecutor;
}
export interface OpenHarnessAgentExtension { setup(context: OpenHarnessExtensionContext): Promise<void> | void; }
export interface OpenHarnessExtensionDiscovery {
  skillRegistry: SkillRegistry;
  plugins: LoadedNativePlugin[];
  agentDefinitions: AgentDefinition[];
  warnings: string[];
  mcpServers: Record<string, McpServerConfig>;
}

export async function discoverOpenHarnessExtensions(cwd: string, settings: Settings): Promise<OpenHarnessExtensionDiscovery> {
  const skillRegistry = new SkillRegistry();
  skillRegistry.registerBundled();
  const plugins: LoadedNativePlugin[] = [];
  const warnings: string[] = [];
  for (const record of await discoverInstalledNativePlugins({ cwd })) {
    const validation = await validateNativePlugin(record.cachePath);
    if (!validation.plugin) {
      warnings.push(...validation.diagnostics.map((item) => `${record.id}: ${item.message}`));
      continue;
    }
    const loaded = await loadNativePlugin(validation.plugin);
    plugins.push(loaded);
    warnings.push(...loaded.diagnostics.map((item) => `${record.id}: ${item.message}`));
    for (const skill of loaded.components.skills?.value ?? []) skillRegistry.register(skill);
  }
  const loader = new SkillLoader(skillRegistry);
  await loader.loadFromDirectory(getSkillsDir(), { source: "user", recursive: true });
  for (const directory of await findProjectSkillDirs(cwd)) {
    await loader.loadFromDirectory(directory, { source: "project", recursive: true });
  }
  const agentDefinitions = plugins.flatMap((plugin) => plugin.components.agents?.value ?? []);
  const pluginMcpServers: Record<string, McpServerConfig> = {};
  for (const plugin of plugins) {
    const compatibilityEnv = buildNativePluginCompatibilityEnvironment({ manifest: plugin.manifest, root: plugin.root, cwd });
    for (const [name, server] of Object.entries(plugin.components.mcpServers?.value ?? {})) {
      pluginMcpServers[name] = server.type === "stdio" ? { ...server, env: { ...server.env, ...compatibilityEnv } } : server;
    }
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
    for (const hook of plugin.components.hooks?.value ?? []) context.hookExecutor.register(hook);
  }
}
