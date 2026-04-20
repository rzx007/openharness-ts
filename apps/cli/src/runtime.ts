import type { Settings, StreamingMessageClient } from "@openharness/core";
import { QueryEngine, ToolRegistry, RuntimeBuilder, RuntimeBundle } from "@openharness/core";
import { AnthropicClient, OpenAICompatibleClient, detectProvider, detectProviderFromEnv, findByName } from "@openharness/api";
import type { BackendType, ProviderSpec } from "@openharness/api";
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
}

export async function bootstrap(options: BootstrapOptions): Promise<RuntimeBundle> {
  const { settings } = options;
  const overrides = options.cliOverrides ?? {};

  const apiClient = resolveApiClient(settings, overrides);

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

export function resolveApiClient(
  settings: Settings,
  overrides?: BootstrapOptions["cliOverrides"],
): StreamingMessageClient {
  const apiKey = resolveApiKey(settings, overrides);
  const baseURL = overrides?.baseUrl ?? settings.baseUrl;
  const providerName = overrides?.provider ?? settings.provider;

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

export function switchApiClientForBundle(
  bundle: RuntimeBundle,
  providerName: string,
  model?: string,
): string | null {
  const settings = { ...bundle.settings };

  if (model) {
    settings.model = model;
  }

  const apiKey = resolveApiKey(settings);
  const spec = findByName(providerName);
  if (!spec) return `Unknown provider: ${providerName}`;

  const baseURL = settings.baseUrl ?? spec.defaultBaseURL;
  const backendType: BackendType = spec.backendType;

  let newClient: StreamingMessageClient;
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

  bundle.switchApiClient(newClient);
  bundle.settings.provider = providerName;
  if (model) {
    bundle.settings.model = model;
    bundle.queryEngine.setModel(model);
  }

  return null;
}

export function resolveApiKey(
  settings: Settings,
  overrides?: BootstrapOptions["cliOverrides"],
): string {
  const explicit = overrides?.apiKey ?? settings.apiKey;
  if (explicit) return explicit;

  const providerName = overrides?.provider ?? settings.provider;
  if (providerName && settings.apiKeys?.[providerName]) {
    return settings.apiKeys[providerName]!;
  }

  const spec = detectProvider(settings.model, undefined, settings.baseUrl);
  if (spec && settings.apiKeys?.[spec.name]) {
    return settings.apiKeys[spec.name]!;
  }

  if (settings.apiKeys) {
    const keys = Object.values(settings.apiKeys);
    if (keys.length > 0) return keys[0]!;
  }

  return "";
}

function resolveBackendFromFormat(format: string): BackendType {
  switch (format) {
    case "openai": return "openai_compat";
    default: return "anthropic";
  }
}
