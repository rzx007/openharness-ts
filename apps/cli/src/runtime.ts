import type { Settings, StreamingMessageClient } from "@openharness/core";
import { QueryEngine, ToolRegistry, RuntimeBuilder, RuntimeBundle } from "@openharness/core";
import { AnthropicClient, OpenAICompatibleClient, detectProvider, detectProviderFromEnv, findByName } from "@openharness/api";
import type { BackendType, ProviderSpec } from "@openharness/api";
import { CredentialStorage } from "@openharness/auth";
import { PermissionChecker } from "@openharness/permissions";
import { HookExecutor } from "@openharness/hooks";
import { createDefaultToolRegistry } from "@openharness/tools";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";

export type PermissionPromptFn = (toolName: string, reason?: string) => Promise<boolean>;

export interface BootstrapOptions {
  settings: Settings;
  cliOverrides?: {
    apiKey?: string;
    baseUrl?: string;
    provider?: string;
    systemPrompt?: string;
    permissionMode?: string;
    maxTurns?: number;
    dangerouslySkipPermissions?: boolean;
    allowedTools?: string;
    disallowedTools?: string;
    effort?: string;
    fastMode?: boolean;
  };
  permissionPrompt?: PermissionPromptFn;
  skillRegistry?: unknown;
  credentialStorage?: CredentialStorage;
}

export async function bootstrap(options: BootstrapOptions): Promise<RuntimeBundle> {
  const { settings } = options;
  const overrides = options.cliOverrides ?? {};
  const storage = options.credentialStorage ?? new CredentialStorage();

  const apiClient = await resolveApiClient(settings, overrides, storage);

  let toolRegistry = createDefaultToolRegistry();

  const effectiveAllowed = new Set([
    ...(settings.permission.allowedTools ?? []),
    ...(overrides.allowedTools ? overrides.allowedTools.split(",") : []),
  ]);
  const effectiveDenied = new Set([
    ...(settings.permission.deniedTools ?? []),
    ...(overrides.disallowedTools ? overrides.disallowedTools.split(",") : []),
  ]);

  if (effectiveAllowed.size > 0) {
    const filtered = new ToolRegistry();
    for (const tool of toolRegistry.getAll()) {
      if (effectiveAllowed.has(tool.name)) filtered.register(tool);
    }
    toolRegistry = filtered;
  }

  if (effectiveDenied.size > 0) {
    const filtered = new ToolRegistry();
    for (const tool of toolRegistry.getAll()) {
      if (!effectiveDenied.has(tool.name)) filtered.register(tool);
    }
    toolRegistry = filtered;
  }

  const mode = overrides.dangerouslySkipPermissions
    ? "full_auto"
    : (overrides.permissionMode as "default" | "plan" | "full_auto") ?? settings.permission.mode;

  const permissionChecker = new PermissionChecker({
    mode,
    allowedTools: [...effectiveAllowed],
    deniedTools: [...effectiveDenied],
    pathRules: settings.permission.pathRules,
    deniedCommands: settings.permission.deniedCommands,
  });

  const hookExecutor = new HookExecutor();

  const systemPrompt = overrides.systemPrompt ?? await buildRuntimeSystemPrompt({
    customPrompt: settings.systemPrompt,
    cwd: process.cwd(),
    fastMode: overrides.fastMode ?? settings.fastMode,
    effort: overrides.effort ?? settings.effort,
    passes: settings.passes,
  });

  const engineOptions = {
    maxTurns: overrides.maxTurns ?? settings.maxTurns,
    systemPrompt,
    model: settings.model,
    permissionPrompt: options.permissionPrompt,
    skillRegistry: options.skillRegistry,
  };

  const queryEngine = new QueryEngine(
    apiClient,
    toolRegistry,
    permissionChecker,
    hookExecutor,
    engineOptions,
  );

  return new RuntimeBuilder()
    .setApiClient(apiClient)
    .setToolRegistry(toolRegistry)
    .setPermissionChecker(permissionChecker)
    .setHookExecutor(hookExecutor)
    .setQueryEngine(queryEngine)
    .build(settings);
}

/**
 * 解析并创建 API 客户端实例。
 *
 * 该函数根据提供的设置、覆盖选项和存储机制，确定正确的 API 密钥、基础 URL、提供商规范以及后端类型，
 * 最终返回相应的流式消息客户端实例。
 *
 * @param settings - 核心配置设置，包含模型、基础 URL、提供商和 API 格式等信息。
 * @param overrides - 可选的引导覆盖选项，用于优先于默认设置配置 CLI 行为（如 baseUrl, provider 等）。
 * @param storage - 可选的凭证存储实例，用于检索 API 密钥；若未提供，则使用默认的 CredentialStorage。
 * @returns 一个解析后的 StreamingMessageClient 实例，用于与选定的后端进行通信。
 */
export async function resolveApiClient(
  settings: Settings,
  overrides?: BootstrapOptions["cliOverrides"],
  storage?: CredentialStorage,
): Promise<StreamingMessageClient> {
  const resolvedStorage = storage ?? new CredentialStorage();
  const apiKey = await resolveApiKey(settings, overrides, resolvedStorage);
  const baseURL = overrides?.baseUrl ?? settings.baseUrl;
  const providerName = overrides?.provider ?? settings.provider;

  // 按优先级顺序解析提供商规范：首先尝试通过名称查找，其次基于模型和凭据检测，最后尝试从环境变量检测
  let spec: ProviderSpec | undefined;
  if (providerName) {
    spec = findByName(providerName);
  }
  if (!spec) {
    spec = detectProvider(settings.model, apiKey, baseURL);
  }
  if (!spec) {
    spec = detectProviderFromEnv(process.env);
  }

  // 确定后端类型：优先使用提供商规范中的类型，否则根据 API 格式推断
  const backendType: BackendType = spec?.backendType ?? resolveBackendFromFormat(settings.apiFormat);

  switch (backendType) {
    case "openai_compat":
      return new OpenAICompatibleClient({
        apiKey,
        baseURL: baseURL ?? spec?.defaultBaseURL,
        model: settings.model,
      });
    case "anthropic":
    default:
      return new AnthropicClient({
        apiKey,
        baseURL,
      });
  }
}

/**
 * 根据指定的提供商名称和模型，为运行时 Bundle 切换 API 客户端。
 *
 * 该函数会解析必要的 API 密钥，根据提供商类型实例化新的流式消息客户端，
 * 并更新 Bundle 中的客户端实例及相关设置。
 *
 * @param bundle - 运行时 Bundle 对象，用于承载和更新 API 客户端及配置。
 * @param providerName - 目标 API 提供商的名称，用于查找对应的规格配置。
 * @param model - 可选的目标模型名称。如果提供，将更新 Bundle 的设置和查询引擎模型。
 * @param storage - 可选的凭证存储对象。如果未提供，将使用默认的 CredentialStorage 实例。
 * @returns 如果操作成功返回 null；如果找不到指定的提供商，则返回错误信息字符串。
 */
export async function switchApiClientForBundle(
  bundle: RuntimeBundle,
  providerName: string,
  model?: string,
  storage?: CredentialStorage,
): Promise<string | null> {
  const resolvedStorage = storage ?? new CredentialStorage();
  const settings = { ...bundle.settings };

  if (model) {
    settings.model = model;
  }

  // 解析 API 密钥并查找提供商规格配置
  const apiKey = await resolveApiKey(settings, undefined, resolvedStorage);
  const spec = findByName(providerName);
  if (!spec) return `Unknown provider: ${providerName}`;

  const baseURL = settings.baseUrl ?? spec.defaultBaseURL;
  const backendType: BackendType = spec.backendType;

  let newClient: StreamingMessageClient;
  // 根据后端类型实例化相应的 API 客户端
  switch (backendType) {
    case "openai_compat":
      newClient = new OpenAICompatibleClient({
        apiKey,
        baseURL: baseURL || undefined,
        model: settings.model,
      });
      break;
    case "anthropic":
    default:
      newClient = new AnthropicClient({
        apiKey,
        baseURL: baseURL || undefined,
      });
      break;
  }

  // 更新 Bundle 的客户端实例、提供商设置以及可选的模型配置
  bundle.switchApiClient(newClient);
  bundle.settings.provider = providerName;
  if (model) {
    bundle.settings.model = model;
    bundle.queryEngine.setModel(model);
  }

  return null;
}

/**
 * 解析并获取 API Key。
 * 
 * 按照以下优先级顺序查找 API Key：
 * 1. 显式提供的覆盖配置或设置中的 apiKey。
 * 2. 根据提供商名称从存储中加载，或从对应的环境变量中获取。
 * 3. 根据模型和基础 URL 自动检测提供商，从存储中加载或从对应的环境变量中获取。
 * 4. 回退到常见的默认环境变量（Anthropic 或 OpenAI）。
 * 5. 优先级：显式 key → settings.apiKey → credentialStorage[providerName] → env[spec.envKey] → detectedProvider storage → ANTHROPIC/OPENAI env fallback → 空 string
 *    不再做模糊 fallback（不取 apiKeys 第一个值）
 * @param settings - 应用设置对象，包含默认的 apiKey、provider、model 和 baseUrl。
 * @param overrides - 可选的命令行覆盖选项，用于优先于 settings 的配置。
 * @param storage - 可选的凭证存储实例，用于持久化或读取 API Key。如果未提供，将创建一个新的默认实例。
 * @returns 解析后的 API Key 字符串，如果未找到则返回空字符串。
 */
export async function resolveApiKey(
  settings: Settings,
  overrides?: BootstrapOptions["cliOverrides"],
  storage?: CredentialStorage,
): Promise<string> {
  // 优先使用显式指定的 apiKey（来自覆盖配置或设置）
  const explicit = overrides?.apiKey ?? settings.apiKey;
  if (explicit) return explicit;

  const resolvedStorage = storage ?? new CredentialStorage();

  // 尝试根据指定的提供商名称获取 API Key（从存储或环境变量）
  const providerName = overrides?.provider ?? settings.provider;
  if (providerName) {
    const stored = await resolvedStorage.loadApiKey(providerName);
    if (stored) return stored;
    const spec = findByName(providerName);
    if (spec?.envKey && process.env[spec.envKey]) return process.env[spec.envKey]!;
  }

  // 尝试通过模型和基础 URL 自动检测提供商，并获取对应的 API Key
  const spec = detectProvider(settings.model, undefined, settings.baseUrl);
  if (spec) {
    const stored = await resolvedStorage.loadApiKey(spec.name);
    if (stored) return stored;
    if (spec.envKey && process.env[spec.envKey]) return process.env[spec.envKey]!;
  }

  // 最后回退到常用的默认环境变量
  const envFallback = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
  if (envFallback) return envFallback;

  return "";
}

function resolveBackendFromFormat(format: string): BackendType {
  switch (format) {
    case "openai": return "openai_compat";
    default: return "anthropic";
  }
}
