import type { Settings, RuntimeBundle, StreamingMessageClient } from "@openharness/core";
import { QueryEngine, ToolRegistry, RuntimeBuilder } from "@openharness/core";
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

  if (overrides.systemPrompt) {
    // use as-is
  }

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

function resolveApiClient(
  settings: Settings,
  overrides: BootstrapOptions["cliOverrides"],
): StreamingMessageClient {
  const apiKey = overrides?.apiKey ?? settings.apiKey ?? "";
  const baseURL = overrides?.baseUrl ?? settings.baseUrl;
  const providerName = overrides?.provider;

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

function resolveBackendFromFormat(format: string): BackendType {
  switch (format) {
    case "openai": return "openai_compat";
    default: return "anthropic";
  }
}
