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
import { activateNativePluginTools, type NativeToolActivationResult } from "./native-tools/activate.js";

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

export async function discoverOpenHarnessExtensions(
  cwd: string,
  settings: Settings,
  options: { pluginsEnabled?: boolean } = {},
): Promise<OpenHarnessExtensionDiscovery> {
  const skillRegistry = new SkillRegistry();
  skillRegistry.registerBundled();
  const plugins: LoadedNativePlugin[] = [];
  const warnings: string[] = [];
  const installedPlugins = (settings.plugins?.enabled ?? true) && (options.pluginsEnabled ?? true)
    ? await discoverInstalledNativePlugins({ cwd })
    : [];
  for (const record of installedPlugins) {
    const missingPermissions = record.requestedPermissions.filter((permission) => !record.approvedPermissions.includes(permission));
    if (missingPermissions.length > 0) {
      warnings.push(`${record.id}: missing approved plugin permissions [${missingPermissions.join(", ")}]; approve the permissions or reinstall the plugin before it can run`);
      continue;
    }
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
  context: Pick<OpenHarnessExtensionContext, "cwd" | "toolRegistry" | "hookExecutor"> & {
    addCleanup(cleanup: () => Promise<void> | void, cleanupSync?: () => void): void;
  },
): Promise<NativeToolActivationResult[]> {
  const toolActivations: NativeToolActivationResult[] = [];
  for (const plugin of discovery.plugins) {
    for (const hook of plugin.components.hooks?.value ?? []) context.hookExecutor.register(hook);
    const activation = await activateNativePluginTools(plugin, {
      cwd: context.cwd,
      toolRegistry: context.toolRegistry,
      addCleanup: (cleanup, cleanupSync) => context.addCleanup(cleanup, cleanupSync),
      onLog: (message) => process.stderr.write(`${message}\n`),
    });
    toolActivations.push(activation);
    for (const diagnostic of activation.diagnostics) {
      process.stderr.write(`[plugins] ${plugin.manifest.id}: ${diagnostic.message}\n`);
    }
  }
  return toolActivations;
}
