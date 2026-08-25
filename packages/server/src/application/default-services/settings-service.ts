import {
  CODEX_DEFAULT_MODEL,
  resolveProviderScopedBaseUrl,
} from "@openharness/api";

import type { SettingsService } from "../settings-api.js";
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
  "allowProjectPlugins",
  "maxTurns",
  "effort",
  "fastMode",
]);

export function createDefaultSettingsService(ref: DaemonSettingsRef): SettingsService {
  return {
    async get() {
      return sanitizeSettings(await readCurrentSettings(ref));
    },
    async patch(patch) {
      await readCurrentSettings(ref);
      let effectivePatch = patch;
      if (typeof patch.path === "string" && "value" in patch) {
        const coerced = coerceConfigValue(patch.path, String(patch.value));
        if (coerced === undefined) throw new Error(`Unknown or invalid config key/value: ${patch.path}`);
        effectivePatch = buildSettingsPatch(
          sanitizeSettings(ref.current),
          patch.path,
          coerced,
        );
      }

      const next = mergeSettingsPatch(ref.current, effectivePatch);
      if (typeof effectivePatch.provider === "string") {
        next.provider = effectivePatch.provider;
        next.baseUrl = resolveProviderScopedBaseUrl(next.baseUrl, effectivePatch.provider);
        if (effectivePatch.provider === "codex" && !effectivePatch.model) {
          next.model = CODEX_DEFAULT_MODEL;
        }
      }
      if (effectivePatch.provider === "auto") {
        delete next.provider;
      }
      await saveSettingsAndRefreshRef(ref, next);
      const restartRuntimes = Object.keys(effectivePatch).some((key) => RUNTIME_RESTART_KEYS.has(key));
      return { settings: sanitizeSettings(next), restartRuntimes };
    },
  };
}

function coerceConfigValue(key: string, value: string): unknown {
  if (["model", "apiFormat", "baseUrl", "systemPrompt", "theme", "outputStyle", "effort", "provider"].includes(key)) {
    return value;
  }
  if (["maxTurns", "maxTokens", "passes"].includes(key)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if ([
    "verbose",
    "fastMode",
    "memory.enabled",
    "memory.sessionMemoryEnabled",
    "memory.autoExtractEnabled",
    "memory.autoDreamEnabled",
    "daemon.autoStart",
  ].includes(key)) {
    if (value === "true" || value === "on") return true;
    if (value === "false" || value === "off") return false;
    return undefined;
  }
  if ([
    "memory.maxFiles",
    "memory.maxEntrypointLines",
    "memory.autoDreamMinHours",
    "memory.autoDreamMinSessions",
  ].includes(key)) {
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
