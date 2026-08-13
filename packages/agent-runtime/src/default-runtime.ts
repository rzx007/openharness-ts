import type { IToolRegistry, Settings, StreamingMessageClient, ToolDefinition } from "@openharness/core";
import { QueryEngine, RuntimeBuilder, RuntimeBundle } from "@openharness/core";
import { normalizeToolNames, resolveAllowedToolNames } from "@openharness/core";
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
import { PermissionChecker, LOCAL_READ_ONLY_TOOLS, READ_ONLY_TOOLS } from "@openharness/permissions";
import { HookExecutor } from "@openharness/hooks";
import { createDefaultToolRegistry } from "@openharness/tools";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import { startSandboxRuntime } from "@openharness/sandbox";
import type { SandboxRuntimeReporter } from "@openharness/sandbox";
import type { SkillRegistry } from "@openharness/skills";

import type { OpenHarnessAgentConfiguration } from "./agent-options.js";

const bundlesWithExitCleanup = new Set<RuntimeBundle>();
let exitCleanupInstalled = false;

export type ToolLimit =
  | { kind: "all" }
  | { kind: "only"; names: ReadonlySet<string> };

interface OpenHarnessRuntimeOptions {
  settings: Settings;
  cwd?: string;
  configuration: OpenHarnessAgentConfiguration;
  skillRegistry?: SkillRegistry;
  credentialStorage?: CredentialStorage;
  sandboxReporter?: SandboxRuntimeReporter;
  sessionId?: string;
  hostCapabilities?: { cron?: boolean };
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
): string[] | undefined {
  const merged = new Set([
    ...(settings.permission.autoApproveTools ?? []),
    ...(overrides.autoApproveTools ?? []),
  ]);
  if (overrides.autoApproveReadOnly) {
    for (const tool of READ_ONLY_TOOLS) {
      if (!LOCAL_READ_ONLY_TOOLS.has(tool)) merged.add(tool);
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
  const roleAllowed = resolveToolLimit(options.roleAllowedTools ?? [], knownToolNames);
  return intersectToolLimits(hostCeiling, roleAllowed);
}

export async function createOpenHarnessRuntime(options: OpenHarnessRuntimeOptions): Promise<RuntimeBundle> {
  const { settings } = options;
  const cwd = options.cwd ?? process.cwd();
  const configuration = options.configuration;
  const storage = options.credentialStorage ?? new CredentialStorage();

  const apiClient = configuration.client ?? await resolveApiClient(settings, configuration, storage);

  const baseToolRegistry = createDefaultToolRegistry({ cron: options.hostCapabilities?.cron });

  const knownToolNames = baseToolRegistry.getAll().map((tool) => tool.name);
  const effectiveAllowed = resolveEffectiveAllowedTools({
    hostToolCeiling: configuration.hostToolCeiling ?? configuration.allowedTools,
    roleAllowedTools: configuration.roleAllowedTools,
    settingsAllowedTools: settings.permission.allowedTools,
    knownToolNames,
  });
  const effectiveDenied = new Set(normalizeToolNames([
    ...(settings.permission.deniedTools ?? []),
    ...(configuration.disallowedTools ?? []),
  ], knownToolNames));

  const toolRegistry = new RuntimeToolRegistry(baseToolRegistry, effectiveAllowed, effectiveDenied);

  const mode = configuration.permissionMode ?? settings.permission.mode;

  // 自动放行三来源合并:settings.permission.autoApproveTools(用户显式配置,
  // 此前从未接线)+ swarm worker / 无头只读模式注入非本地 READ_ONLY_TOOLS。
  // denied 永远优先于 autoApprove(checker 内保证)。
  const autoApproveTools = resolveAutoApproveTools(settings, configuration);

  const permissionChecker = new PermissionChecker({
    mode,
    cwd,
    allowedTools: effectiveAllowed.kind === "only" ? [...effectiveAllowed.names] : [],
    deniedTools: [...effectiveDenied],
    pathRules: settings.permission.pathRules,
    deniedCommands: settings.permission.deniedCommands,
    autoApproveTools,
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
  const systemPrompt = configuration.systemPrompt ?? await buildRuntimeSystemPrompt({
    customPrompt: settings.systemPrompt,
    cwd,
    permissionMode: mode,
    fastMode: configuration.fastMode ?? settings.fastMode,
    effort: configuration.effort ?? settings.effort,
    passes: settings.passes,
    skillsList: options.skillRegistry?.modelVisibleList(),
  });

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

  const bundle = new RuntimeBuilder()
    .setApiClient(apiClient)
    .setToolRegistry(toolRegistry)
    .setPermissionChecker(permissionChecker)
    .setHookExecutor(hookExecutor)
    .setQueryEngine(queryEngine)
    .build(settings);

  await attachSandboxRuntime(bundle, cwd, options.sandboxReporter, options.sessionId);
  return bundle;
}

class RuntimeToolRegistry implements IToolRegistry {
  constructor(
    private readonly inner: IToolRegistry,
    private readonly allowedTools: ToolLimit,
    private readonly deniedTools: ReadonlySet<string>,
  ) {}

  register(tool: ToolDefinition): void {
    this.inner.register(tool);
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

  private isVisible(name: string): boolean {
    if (this.deniedTools.has(name)) return false;
    return this.allowedTools.kind === "all" || this.allowedTools.names.has(name);
  }
}

function resolveToolLimit(tools: string[], knownToolNames: string[]): ToolLimit {
  const names = resolveAllowedToolNames(tools, knownToolNames);
  return names.length === 0 ? { kind: "all" } : { kind: "only", names: new Set(names) };
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
): Promise<void> {
  const sandboxRuntime = await startSandboxRuntime({
    settings: bundle.settings,
    cwd,
    sessionId,
    reporter,
  });
  bundle.sandboxStatus = sandboxRuntime.status;

  if (sandboxRuntime.status.backend !== "docker" || !sandboxRuntime.status.active) {
    return;
  }

  bundle.addCleanup(
    () => sandboxRuntime.stop(),
    () => sandboxRuntime.stopSync(),
  );
  registerExitCleanup(bundle);
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
  const rawBaseURL = configuration?.baseUrl ?? settings.baseUrl;
  const baseURL = providerName
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
  const backendType: BackendType = spec?.backendType ?? resolveBackendFromFormat(settings.apiFormat);

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
    case "openai": return "openai_compat";
    default: return "anthropic";
  }
}
