import type {
  IToolRegistry,
  Settings,
  StreamingMessageClient,
  ToolDefinition,
} from "@openharness/core";
import {
  QueryEngine,
  RuntimeBuilder,
  RuntimeBundle,
  ToolRegistrationError,
} from "@openharness/core";
import {
  assertNoRemovedLifecycleToolNames,
  normalizeToolNames,
  resolveAllowedToolNames,
} from "@openharness/core";
import {
  AnthropicClient,
  CodexSubscriptionClient,
  OpenAICompatibleClient,
  detectProvider,
  detectProviderFromEnv,
  findByName,
  resolveProviderScopedBaseUrl,
} from "@openharness/api";
import type { BackendType, ProviderSpec } from "@openharness/api";
import { CredentialStorage, resolveApiKey } from "@openharness/auth";
import {
  PermissionChecker,
  LOCAL_READ_ONLY_TOOLS,
  READ_ONLY_TOOLS,
} from "@openharness/permissions";
import { HookExecutor } from "@openharness/hooks";
import { createDefaultToolRegistry } from "@openharness/tools";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import { startSandboxRuntime } from "@openharness/sandbox";
import type { SandboxRuntimeReporter } from "@openharness/sandbox";
import type { SkillRegistry } from "@openharness/skills";
import type { AgentDefinition } from "@openharness/coordinator";
import type { OpenHarnessAgentConfiguration } from "./agent-options.js";
import type { ResolvedAgentCapabilities } from "./capability-resolution.js";

const bundlesWithExitCleanup = new Set<RuntimeBundle>();
let exitCleanupInstalled = false;

export type ToolLimit =
  { kind: "all" } | { kind: "only"; names: ReadonlySet<string> };

export interface CustomProviderRuntimeConfig {
  backendType: "openai_compat";
  baseURL: string;
  headers?: Record<string, string>;
}

export function resolveCustomProviderRuntime(
  settings: Settings,
  providerName: string | undefined,
): CustomProviderRuntimeConfig | undefined {
  if (!providerName) return undefined;
  const provider = settings.customProviders?.find((item) => item.id === providerName);
  if (!provider) return undefined;
  return {
    backendType: "openai_compat",
    baseURL: provider.baseUrl,
    ...(provider.headers ? { headers: provider.headers } : {}),
  };
}

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
  attachmentResourceRoot?: string;
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

export function resolveRuntimeModel(
  settings: Settings,
  overrides: { model?: string | undefined },
): string {
  return overrides.model ?? settings.model;
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
  const imageToText = availableValue(options.capabilities?.imageToText);
  const attachments = availableValue(options.capabilities?.attachments);
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
    imageToText: imageToText !== undefined,
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

  const toolRegistry = new RuntimeToolRegistry(
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
  queryEngine.setImageToText(imageToText);
  if (attachments) queryEngine.setAttachments(attachments);
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
    options.attachmentResourceRoot,
  );
  return bundle;
}

function applyConfiguredTools(
  registry: IToolRegistry,
  configuration: OpenHarnessAgentConfiguration,
): Set<string> {
  const additions = configuration.tools ?? [];
  const overrides = configuration.toolOverrides ?? [];
  const trustedOverrides = new Set(configuration.trustedToolOverrides ?? []);
  const additionNames = assertUniqueToolNames(additions, "tools");
  const overrideNames = assertUniqueToolNames(overrides, "toolOverrides");

  for (const name of trustedOverrides) {
    if (!overrideNames.has(name)) {
      throw new Error(
        `trustedToolOverrides entry "${name}" must also appear in toolOverrides`,
      );
    }
  }

  for (const name of additionNames) {
    if (overrideNames.has(name)) {
      throw new Error(
        `Tool "${name}" cannot appear in both tools and toolOverrides`,
      );
    }
    if (registry.has(name)) {
      throw new ToolRegistrationError(
        "tool_already_registered",
        `Tool "${name}" is already registered by builtin; use toolOverrides`,
      );
    }
  }
  for (const name of overrideNames) {
    if (!registry.has(name)) {
      throw new ToolRegistrationError(
        "tool_override_target_not_found",
        `Tool override target "${name}" is not registered`,
      );
    }
    if (
      trustedOverrides.has(name) &&
      registry.inspect(name)?.source.kind !== "builtin"
    ) {
      throw new Error(
        `trustedToolOverrides entry "${name}" must replace a builtin Tool`,
      );
    }
  }

  for (const tool of additions) registry.register(tool, { kind: "agent" });
  for (const tool of overrides) registry.override(tool, { kind: "agent" });
  return trustedOverrides;
}

function assertUniqueToolNames(
  tools: readonly ToolDefinition[],
  field: "tools" | "toolOverrides",
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate Tool "${tool.name}" in ${field}`);
    }
    names.add(tool.name);
  }
  return names;
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

class RuntimeToolRegistry implements IToolRegistry {
  constructor(
    private readonly inner: IToolRegistry,
    private readonly allowedTools: ToolLimit,
    private readonly deniedTools: ReadonlySet<string>,
  ) {}

  register(tool: ToolDefinition, source?: Parameters<IToolRegistry["register"]>[1]): void {
    this.inner.register(tool, source);
  }

  override(tool: ToolDefinition, source: Parameters<IToolRegistry["override"]>[1]): void {
    this.inner.override(tool, source);
  }

  unregister(name: string): boolean {
    return this.inner.unregister?.(name) ?? false;
  }

  get(name: string): ToolDefinition | undefined {
    const tool = this.inner.get(name);
    return tool && this.isVisible(tool.name) ? tool : undefined;
  }

  getAll(): ToolDefinition[] {
    return this.inner.getAll().filter((tool) => this.isVisible(tool.name));
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  inspect(name: string) {
    return this.isVisible(name) ? this.inner.inspect(name) : undefined;
  }

  internalRegistry(): IToolRegistry {
    return this.inner;
  }

  private isVisible(name: string): boolean {
    if (this.deniedTools.has(name)) return false;
    return (
      this.allowedTools.kind === "all" || this.allowedTools.names.has(name)
    );
  }
}

export function getInternalToolRegistry(registry: IToolRegistry): IToolRegistry {
  return registry instanceof RuntimeToolRegistry
    ? registry.internalRegistry()
    : registry;
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

async function attachSandboxRuntime(
  bundle: RuntimeBundle,
  cwd: string,
  reporter?: SandboxRuntimeReporter,
  sessionId?: string,
  attachmentResourceRoot?: string,
): Promise<void> {
  const sandboxRuntime = await startSandboxRuntime({
    settings: bundle.settings,
    cwd,
    sessionId,
    reporter,
    ...(attachmentResourceRoot
      ? {
          managedReadOnlyMounts: [{
            source: attachmentResourceRoot,
            target: "/mnt/openharness-attachments",
          }],
        }
      : {}),
  });
  bundle.sandboxStatus = sandboxRuntime.status;

  if (
    sandboxRuntime.status.backend !== "docker" ||
    !sandboxRuntime.status.active
  ) {
    return;
  }

  bundle.addCleanup(
    () => sandboxRuntime.stop(),
    () => sandboxRuntime.stopSync(),
  );
  registerExitCleanup(bundle);
}

function availableValue<T>(
  capability: import("./capability-resolution.js").ResolvedCapability<T> | undefined,
): T | undefined {
  return capability?.status === "available" ? capability.value : undefined;
}

function registerExitCleanup(bundle: RuntimeBundle): void {
  bundlesWithExitCleanup.add(bundle);
  bundle.addCleanup(() => {
    bundlesWithExitCleanup.delete(bundle);
  });
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.on("exit", () => {
    for (const runtime of bundlesWithExitCleanup) {
      runtime.closeSync();
    }
    bundlesWithExitCleanup.clear();
  });
}

/**
 * 解析并创建 API 客户端实例。
 *
 * 该函数根据提供的设置、覆盖选项和存储机制，确定正确的 API 密钥、基础 URL、提供商规范以及后端类型，
 * 最终返回相应的流式消息客户端实例。
 *
 * @param settings - 核心配置设置，包含模型、基础 URL、提供商和 API 格式等信息。
 * @param configuration - 可选的 SDK 配置，用于覆盖默认设置（如 baseUrl, provider 等）。
 * @param storage - 可选的凭证存储实例，用于检索 API 密钥；若未提供，则使用默认的 CredentialStorage。
 * @returns 一个解析后的 StreamingMessageClient 实例，用于与选定的后端进行通信。
 */
async function resolveApiClient(
  settings: Settings,
  configuration?: OpenHarnessAgentConfiguration,
  storage?: CredentialStorage,
): Promise<StreamingMessageClient> {
  const resolvedStorage = storage ?? new CredentialStorage();
  const apiKey = await resolveApiKey(settings, configuration, resolvedStorage);
  const providerName = configuration?.provider ?? settings.provider;
  const customProvider = resolveCustomProviderRuntime(settings, providerName);
  const rawBaseURL = configuration?.baseUrl ?? customProvider?.baseURL ?? settings.baseUrl;
  const baseURL = providerName && !customProvider
    ? resolveProviderScopedBaseUrl(rawBaseURL, providerName)
    : rawBaseURL;
  const runtimeModel = resolveRuntimeModel(settings, configuration ?? {});

  // 按优先级顺序解析提供商规范：首先尝试通过名称查找，其次基于模型和凭据检测，最后尝试从环境变量检测
  let spec: ProviderSpec | undefined;
  if (providerName) {
    spec = findByName(providerName);
  }
  if (!spec) {
    spec = detectProvider(runtimeModel, apiKey, baseURL);
  }
  if (!spec) {
    spec = detectProviderFromEnv(process.env);
  }

  // 确定后端类型：优先使用提供商规范中的类型，否则根据 API 格式推断
  const backendType: BackendType =
    customProvider?.backendType ?? spec?.backendType ??
    resolveBackendFromFormat(configuration?.apiFormat ?? settings.apiFormat);

  switch (backendType) {
    case "codex":
      return new CodexSubscriptionClient({
        apiKey,
        baseURL: baseURL ?? spec?.defaultBaseURL,
        model: runtimeModel,
      });
    case "openai_compat":
      return new OpenAICompatibleClient({
        apiKey,
        baseURL: baseURL ?? spec?.defaultBaseURL,
        model: runtimeModel,
        ...(customProvider?.headers ? { headers: customProvider.headers } : {}),
      });
    case "anthropic":
    default:
      return new AnthropicClient({
        apiKey,
        baseURL,
      });
  }
}

function resolveBackendFromFormat(format: string): BackendType {
  switch (format) {
    case "openai":
      return "openai_compat";
    default:
      return "anthropic";
  }
}
