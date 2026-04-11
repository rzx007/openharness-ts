import type { Settings, RuntimeBundle, StreamingMessageClient } from "@openharness/core";
import { QueryEngine, ToolRegistry, RuntimeBuilder } from "@openharness/core";
import { AnthropicClient, OpenAICompatibleClient, CopilotClient, detectProvider, detectProviderFromEnv, findByName } from "@openharness/api";
import type { BackendType, ProviderSpec } from "@openharness/api";
import { PermissionChecker } from "@openharness/permissions";
import { HookExecutor } from "@openharness/hooks";
import { createDefaultToolRegistry } from "@openharness/tools";
import { buildSystemPrompt } from "@openharness/prompts";

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
  };
}

export async function bootstrap(options: BootstrapOptions): Promise<RuntimeBundle> {
  const { settings } = options;
  const overrides = options.cliOverrides ?? {};

  const apiClient = resolveApiClient(settings, overrides);

  let toolRegistry = createDefaultToolRegistry();

  if (overrides.allowedTools) {
    const allowed = new Set(overrides.allowedTools.split(","));
    const filtered = new ToolRegistry();
    for (const tool of toolRegistry.getAll()) {
      if (allowed.has(tool.name)) filtered.register(tool);
    }
    toolRegistry = filtered;
  }

  if (overrides.disallowedTools) {
    const disallowed = new Set(overrides.disallowedTools.split(","));
    const filtered = new ToolRegistry();
    for (const tool of toolRegistry.getAll()) {
      if (!disallowed.has(tool.name)) filtered.register(tool);
    }
    toolRegistry = filtered;
  }

  const mode = overrides.dangerouslySkipPermissions
    ? "full_auto"
    : (overrides.permissionMode as Settings["permissionMode"]) ?? settings.permissionMode;

  const permissionChecker = new PermissionChecker({
    mode,
    rules: [],
  });

  const hookExecutor = new HookExecutor();

  const systemPrompt = overrides.systemPrompt ?? await buildDefaultSystemPrompt(settings);

  const engineOptions = {
    maxTurns: overrides.maxTurns ?? settings.maxTurns,
    systemPrompt,
    model: settings.model,
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
  const baseURL = overrides?.baseUrl;
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
    case "copilot":
      return new CopilotClient({ apiKey, baseURL });
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
    case "copilot": return "copilot";
    case "openai": return "openai_compat";
    default: return "anthropic";
  }
}

async function buildDefaultSystemPrompt(settings: Settings): Promise<string> {
  const { platform } = process;
  const shell = process.env.COMSPEC ?? process.env.SHELL ?? "/bin/sh";
  const cwd = process.cwd();
  const date = new Date().toISOString().split("T")[0]!;

  return buildSystemPrompt(
    `You are OpenHarness, an AI coding assistant. You help users with software engineering tasks.`,
    { cwd, platform: `${platform.arch} ${platform.type}`, shell, date },
  );
}
