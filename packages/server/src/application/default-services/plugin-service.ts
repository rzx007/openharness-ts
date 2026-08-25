import { saveSettings } from "@openharness/core";

import type { PluginService } from "../settings-api.js";
import type { DaemonSettingsRef } from "./shared.js";

export function createDefaultPluginService(ref: DaemonSettingsRef): PluginService {
  return {
    async list({ cwd }) {
      const { loadPlugins } = await import("@openharness/plugins");
      const { plugins, warnings } = await loadPlugins(ref.current, cwd);
      return {
        plugins: plugins.map((plugin) => ({
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          enabled: plugin.enabled,
          skillCount: plugin.skills.length,
          commandCount: plugin.commands.length,
          hookCount: plugin.hooks.length,
          agentCount: plugin.agents.length,
        })),
        warnings,
      };
    },
    async setEnabled({ name, enabled }) {
      const next = {
        ...ref.current,
        plugins: { ...(ref.current.plugins ?? {}), [name]: enabled },
      };
      await saveSettings(next);
      ref.current = next;
      return {
        message: `${enabled ? "Enabled" : "Disabled"} plugin '${name}'. Use /reload-plugins to rediscover immediately, or wait for next runtime warm.`,
        restartRuntimes: true,
      };
    },
  };
}
