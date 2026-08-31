import {
  CODEX_DEFAULT_MODEL,
  createModelCatalogService,
  findByName,
  resolveProviderScopedBaseUrl,
  type ModelsDevCatalog,
} from "@openharness/api";

import type { SettingsService } from "../settings-api.js";
import { catalogProviderModelIds } from "./catalog-provider-mapping.js";
import {
  mergeSettingsPatch,
  readCurrentSettings,
  sanitizeSettings,
  saveSettingsAndRefreshRef,
  isRecord,
  type DaemonSettingsRef,
} from "./shared.js";

const RUNTIME_RESTART_KEYS = new Set([
  "provider",
  "baseUrl",
  "apiFormat",
  "apiKey",
  "mcpServers",
  "plugins",
  "maxTurns",
  "effort",
  "fastMode",
  "workStyle",
]);

export function createDefaultSettingsService(
  ref: DaemonSettingsRef,
): SettingsService {
  const catalogService = createModelCatalogService();
  return {
    async get() {
      return sanitizeSettings(await readCurrentSettings(ref));
    },
    async patch(patch) {
      await readCurrentSettings(ref);
      if (
        "workStyle" in patch &&
        patch.workStyle !== "practical" &&
        patch.workStyle !== "efficient"
      ) {
        throw new Error("Unknown work style. Use practical or efficient.");
      }
      let effectivePatch = patch;
      if (typeof patch.path === "string" && "value" in patch) {
        const coerced = coerceConfigValue(patch.path, String(patch.value));
        if (coerced === undefined)
          throw new Error(`Unknown or invalid config key/value: ${patch.path}`);
        effectivePatch = buildSettingsPatch(
          sanitizeSettings(ref.current),
          patch.path,
          coerced,
        );
      }

      const next = mergeSettingsPatch(ref.current, effectivePatch);
      if (typeof effectivePatch.provider === "string") {
        next.provider = effectivePatch.provider;
        next.baseUrl = resolveProviderScopedBaseUrl(
          next.baseUrl,
          effectivePatch.provider,
        );
        if (effectivePatch.provider !== "auto") {
          next.model = await resolveProviderModelSelection({
            provider: effectivePatch.provider,
            requestedModel:
              typeof effectivePatch.model === "string"
                ? effectivePatch.model
                : undefined,
            currentModel:
              typeof next.model === "string" ? next.model : undefined,
            customProviders: next.customProviders,
            catalog: await catalogService.load(),
          });
        }
      }
      if (effectivePatch.provider === "auto") {
        delete next.provider;
      }
      await saveSettingsAndRefreshRef(ref, next);
      const restartRuntimes = Object.keys(effectivePatch).some((key) =>
        RUNTIME_RESTART_KEYS.has(key),
      );
      return { settings: sanitizeSettings(next), restartRuntimes };
    },
  };
}

async function resolveProviderModelSelection(input: {
  provider: string;
  requestedModel?: string;
  currentModel?: string;
  customProviders?: unknown;
  catalog: ModelsDevCatalog;
}): Promise<string> {
  if (input.provider === "codex") {
    return input.requestedModel || input.currentModel || CODEX_DEFAULT_MODEL;
  }
  const customModelIds = customProviderModelIds(
    input.customProviders,
    input.provider,
  );
  if (customModelIds.length > 0) {
    return pickPreferredModel(
      customModelIds,
      input.requestedModel,
      input.currentModel,
      input.provider,
    );
  }

  const catalogModelIds = catalogProviderModelIds(
    input.catalog,
    input.provider,
  );
  if (catalogModelIds.length > 0) {
    return pickPreferredModel(
      catalogModelIds,
      input.requestedModel,
      input.currentModel,
      input.provider,
    );
  }

  if (!findByName(input.provider)) {
    throw new Error(`未知供应商：${input.provider}`);
  }
  throw new Error(`供应商 ${input.provider} 当前没有可用模型，无法设为默认。`);
}

function pickPreferredModel(
  models: string[],
  requestedModel: string | undefined,
  currentModel: string | undefined,
  provider: string,
): string {
  if (requestedModel && models.includes(requestedModel)) return requestedModel;
  if (requestedModel) {
    throw new Error(`模型 ${requestedModel} 不属于 provider ${provider}。`);
  }
  if (currentModel && models.includes(currentModel)) return currentModel;
  return models[0]!;
}

function customProviderModelIds(
  customProviders: unknown,
  providerName: string,
): string[] {
  if (!Array.isArray(customProviders)) return [];
  const match = customProviders.find(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).id === providerName,
  );
  if (!match || typeof match !== "object") return [];
  const models = (match as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (!model || typeof model !== "object") return [];
    const id = (model as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

function coerceConfigValue(key: string, value: string): unknown {
  if (
    [
      "model",
      "apiFormat",
      "baseUrl",
      "systemPrompt",
      "theme",
      "outputStyle",
      "effort",
      "provider",
    ].includes(key)
  ) {
    return value;
  }
  if (["maxTurns", "maxTokens", "passes"].includes(key)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (
    [
      "verbose",
      "fastMode",
      "plugins.enabled",
      "context.enabled",
      "context.automaticExtractionEnabled",
      "sessionContinuity.enabled",
      "daemon.autoStart",
    ].includes(key)
  ) {
    if (value === "true" || value === "on") return true;
    if (value === "false" || value === "off") return false;
    return undefined;
  }
  if (
    [
      "context.explicitCommitThreshold",
      "context.automaticEnvironmentCommitThreshold",
      "context.candidateRetentionDays",
      "context.promptMaxChars",
      "context.promptMaxEntries",
    ].includes(key)
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (key === "permission.mode") {
    return ["default", "plan", "full_auto"].includes(value) ? value : undefined;
  }
  return value;
}

function buildSettingsPatch(
  settings: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const [head, child] = key.split(".");
  if (!head || !child) return { [key]: value };
  const current = isRecord(settings[head]) ? settings[head] : {};
  return { [head]: { ...current, [child]: value } };
}
