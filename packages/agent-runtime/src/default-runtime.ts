import type { Settings } from "@openharness/core";
import {
  QueryEngine,
  RuntimeBuilder,
  RuntimeBundle,
} from "@openharness/core";
import {
  assertNoRemovedLifecycleToolNames,
  normalizeToolNames,
  resolveAllowedToolNames,
} from "@openharness/core";
import { CredentialStorage } from "@openharness/auth";
import {
  PermissionChecker,
  LOCAL_READ_ONLY_TOOLS,
  READ_ONLY_TOOLS,
} from "@openharness/permissions";
import { HookExecutor } from "@openharness/hooks";
import { createDefaultToolRegistry } from "@openharness/tools";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import type { SandboxRuntimeReporter } from "@openharness/sandbox";
import type { SkillRegistry } from "@openharness/skills";
import type { AgentDefinition } from "@openharness/coordinator";

import type { OpenHarnessAgentConfiguration } from "./agent-options.js";
import type { ResolvedAgentCapabilities } from "./capability-resolution.js";
import {
  resolveApiClient,
  resolveCustomProviderRuntime,
  resolveRuntimeModel,
  type CustomProviderRuntimeConfig,
} from "./default-runtime-provider.js";
import { attachSandboxRuntime } from "./default-runtime-sandbox.js";
import {
  applyConfiguredTools,
  createVisibilityToolRegistry,
  getInternalToolRegistry,
  type ToolLimit,
} from "./default-runtime-tools.js";

export type { ToolLimit };
export type { CustomProviderRuntimeConfig };
export {
  resolveCustomProviderRuntime,
  resolveRuntimeModel,
};
export { getInternalToolRegistry };

interface OpenHarnessRuntimeOptions {
  settings: Settings;
  cwd?: string;
  configuration: OpenHarnessAgentConfiguration;
  skillRegistry?: SkillRegistry;
  agentDefinitions?: AgentDefinition[];
  credentialStorage?: CredentialStorage;
  sandboxReporter?: SandboxRuntimeReporter;
  sessionId?: string;
  capabilities?: ResolvedAgentCapabilities;
}

/**
 * 合并自动放行工具：settings.permission.autoApproveTools（用户显式配置）
 * + autoApproveReadOnly 注入的非本地 READ_ONLY_TOOLS。
 * 本地只读工具(Read/Glob/Grep/Lsp)不在这里隐式注入，交给 PermissionChecker
 * 的 cwd 守卫处理；settings/overrides 显式 autoApproveTools 仍按用户授权保留。
 * 空合并返回 undefined（checker 走默认行为）。
 */
export function resolveAutoApproveTools(
  settings: Settings,
  overrides: { autoApproveReadOnly?: boolean; autoApproveTools?: string[] },
  trustedBuiltinToolNames?: ReadonlySet<string>,
): string[] | undefined {
  const merged = new Set([
    ...(settings.permission.autoApproveTools ?? []),
    ...(overrides.autoApproveTools ?? []),
  ]);
  if (overrides.autoApproveReadOnly) {
    for (const tool of READ_ONLY_TOOLS) {
      if (
        !LOCAL_READ_ONLY_TOOLS.has(tool) &&
        (!trustedBuiltinToolNames || trustedBuiltinToolNames.has(tool))
      ) {
        merged.add(tool);
      }
    }
  }
  return merged.size > 0 ? [...merged] : undefined;
}

export function resolveEffectiveAllowedTools(options: {
  hostToolCeiling?: string[];
  roleAllowedTools?: string[];
  settingsAllowedTools?: string[];
  knownToolNames?: string[];
}): ToolLimit {
  const knownToolNames = options.knownToolNames ?? [];
  const hostCeiling = resolveToolLimit(
    options.hostToolCeiling ?? options.settingsAllowedTools ?? [],
    knownToolNames,
  );
  const roleAllowed = resolveToolLimit(
    options.roleAllowedTools ?? [],
    knownToolNames,
  );
  return intersectToolLimits(hostCeiling, roleAllowed);
}

export async function createOpenHarnessRuntime(
  options: OpenHarnessRuntimeOptions,
): Promise<RuntimeBundle> {
  const { settings } = options;
  const cwd = options.cwd ?? process.cwd();
  const configuration = options.configuration;
  const storage = options.credentialStorage ?? new CredentialStorage();

  validateLifecycleToolConfiguration(settings, configuration);

  const apiClient =
    configuration.client ??
    (await resolveApiClient(settings, configuration, storage));

  const terminal = availableValue(options.capabilities?.terminal);
  const jobs = availableValue(options.capabilities?.jobs);
  const backgroundShell = availableValue(options.capabilities?.backgroundShell);
  const childEnvironment = availableValue(options.capabilities?.childEnvironment);
  const workflowRepository = availableValue(options.capabilities?.workflowRepository);
  const schedules = availableValue(options.capabilities?.schedules);
  const includeBackgroundShell = options.capabilities === undefined
    ? undefined
    : backgroundShell !== undefined && jobs !== undefined;
  const includeDelegation = options.capabilities === undefined
    ? undefined
    : childEnvironment !== undefined && jobs !== undefined;
  const baseToolRegistry = createDefaultToolRegistry({
    schedules: schedules !== undefined,
    terminal: terminal !== undefined,
    jobs: jobs !== undefined,
    backgroundShell: includeBackgroundShell,
    childEnvironment: includeDelegation,
    agentDefinitions: options.agentDefinitions,
    workflowRepository,
  });
  const trustedOverrides = applyConfiguredTools(baseToolRegistry, configuration);
  const trustedBuiltinToolNames = new Set(
    baseToolRegistry.getAll()
      .filter((tool) =>
        baseToolRegistry.inspect(tool.name)?.source.kind === "builtin" ||
        trustedOverrides.has(tool.name)
      )
      .map((tool) => tool.name),
  );

  const knownToolNames = baseToolRegistry.getAll().map((tool) => tool.name);
  const effectiveAllowed = resolveEffectiveAllowedTools({
    hostToolCeiling: configuration.hostToolCeiling,
    roleAllowedTools: configuration.roleAllowedTools,
    settingsAllowedTools: settings.permission.allowedTools,
    knownToolNames,
  });
  const effectiveDenied = new Set(
    normalizeToolNames(
      [
        ...(settings.permission.deniedTools ?? []),
        ...(configuration.disallowedTools ?? []),
      ],
      knownToolNames,
    ),
  );

  const toolRegistry = createVisibilityToolRegistry(
    baseToolRegistry,
    effectiveAllowed,
    effectiveDenied,
  );

  const mode = configuration.permissionMode ?? settings.permission.mode;

  // 自动放行三来源合并:settings.permission.autoApproveTools(用户显式配置,
  // 此前从未接线)+ swarm worker / 无头只读模式注入非本地 READ_ONLY_TOOLS。
  // denied 永远优先于 autoApprove(checker 内保证)。
  const autoApproveTools = resolveAutoApproveTools(
    settings,
    configuration,
    trustedBuiltinToolNames,
  );

  const permissionChecker = new PermissionChecker({
    mode,
    cwd,
    allowedTools:
      effectiveAllowed.kind === "only" ? [...effectiveAllowed.names] : [],
    deniedTools: [...effectiveDenied],
    pathRules: settings.permission.pathRules,
    deniedCommands: settings.permission.deniedCommands,
    autoApproveTools,
    trustedLocalReadOnlyToolNames: [...trustedBuiltinToolNames],
  });

  const hookExecutor = new HookExecutor({
    cwd,
    sessionId: options.sessionId,
    settings,
  });
  const runtimeModel = resolveRuntimeModel(settings, configuration);

  // 自定义 prompt（CLI override）优先，跳过默认 prompt 构建。只在走默认 prompt
  // 时才注入 model 可见的 skills 段，使 print/backend 三模式与 REPL 一致——REPL
  // 由 refreshSystemPrompt 注入，print/backend 走默认 composition root 由此处注入。
  const systemPrompt =
    configuration.systemPrompt ??
    (await buildRuntimeSystemPrompt({
      customPrompt: settings.systemPrompt,
      cwd,
      permissionMode: mode,
      workStyle: settings.workStyle,
      fastMode: configuration.fastMode ?? settings.fastMode,
      effort: configuration.effort ?? settings.effort,
      passes: settings.passes,
      includeBackgroundShell,
      includeDelegation,
      skillsList: options.skillRegistry?.modelVisibleList(),
    }));

  const engineOptions = {
    maxTurns: configuration.maxTurns ?? settings.maxTurns,
    systemPrompt,
    model: runtimeModel,
    cwd,
    sessionId: options.sessionId,
    settings,
    skillRegistry: options.skillRegistry,
  };

  const queryEngine = new QueryEngine(
    apiClient,
    toolRegistry,
    permissionChecker,
    hookExecutor,
    engineOptions,
  );
  queryEngine.setTerminal(terminal);
  queryEngine.setJobs(jobs);
  queryEngine.setBackgroundShell(backgroundShell);
  queryEngine.setSchedules(schedules);

  const bundle = new RuntimeBuilder()
    .setApiClient(apiClient)
    .setToolRegistry(toolRegistry)
    .setPermissionChecker(permissionChecker)
    .setHookExecutor(hookExecutor)
    .setQueryEngine(queryEngine)
    .build(settings);

  await attachSandboxRuntime(
    bundle,
    cwd,
    options.sandboxReporter,
    options.sessionId,
  );
  return bundle;
}

function validateLifecycleToolConfiguration(
  settings: Settings,
  configuration: OpenHarnessAgentConfiguration,
): void {
  const configuredLists: Array<[string, readonly string[] | undefined]> = [
    ["settings.permission.allowedTools", settings.permission.allowedTools],
    ["settings.permission.deniedTools", settings.permission.deniedTools],
    [
      "settings.permission.autoApproveTools",
      settings.permission.autoApproveTools,
    ],
    ["configuration.hostToolCeiling", configuration.hostToolCeiling],
    ["configuration.roleAllowedTools", configuration.roleAllowedTools],
    ["configuration.disallowedTools", configuration.disallowedTools],
    ["configuration.autoApproveTools", configuration.autoApproveTools],
  ];
  for (const [source, tools] of configuredLists) {
    assertNoRemovedLifecycleToolNames(tools ?? [], source);
  }
}

function resolveToolLimit(
  tools: string[],
  knownToolNames: string[],
): ToolLimit {
  const names = resolveAllowedToolNames(tools, knownToolNames);
  return names.length === 0
    ? { kind: "all" }
    : { kind: "only", names: new Set(names) };
}

function intersectToolLimits(left: ToolLimit, right: ToolLimit): ToolLimit {
  if (left.kind === "all") return right;
  if (right.kind === "all") return left;
  const names = [...left.names].filter((tool) => right.names.has(tool));
  return { kind: "only", names: new Set(names) };
}

function availableValue<T>(
  capability: import("./capability-resolution.js").ResolvedCapability<T> | undefined,
): T | undefined {
  return capability?.status === "available" ? capability.value : undefined;
}
