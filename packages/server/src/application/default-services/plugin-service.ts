import { getInstalledPluginStorePath } from "@openharness/core";
import {
  installLocalNativePlugin,
  readInstalledPluginStore,
  updateInstalledPluginStore,
  validateNativePlugin,
} from "@openharness/plugins";
import type { PluginInfo, PluginService } from "../settings-api.js";
import type { DaemonSettingsRef } from "./shared.js";

function applies(record: { scope: string; projectDir?: string }, cwd: string): boolean {
  return record.scope === "user" || record.scope === "managed" || record.projectDir?.toLowerCase() === cwd.toLowerCase();
}

export function createDefaultPluginService(_ref: DaemonSettingsRef): PluginService {
  return {
    async list({ cwd }) {
      const store = await readInstalledPluginStore(getInstalledPluginStorePath());
      const plugins: PluginInfo[] = [];
      for (const record of Object.values(store.plugins).filter((item) => applies(item, cwd))) {
        const validation = await validateNativePlugin(record.cachePath);
        const manifest = validation.plugin?.manifest;
        const inventory: Record<string, number> = {};
        if (manifest) for (const [kind, values] of Object.entries(manifest.components)) inventory[kind] = values.length;
        plugins.push({
          identity: {
            id: record.id,
            name: manifest?.name ?? record.id,
            version: manifest?.version ?? record.currentVersion,
            ...(manifest?.displayName ? { displayName: manifest.displayName } : {}),
          },
          origin: record.origin,
          ...(record.sourceFormat ? { sourceFormat: record.sourceFormat } : {}),
          scope: record.scope,
          enabled: record.enabled,
          installation: validation.status === "valid" ? "installed" : "invalid",
          activation: record.enabled ? "reload-required" : "inactive",
          inventory,
          permissions: {
            requested: record.requestedPermissions,
            approved: record.approvedPermissions,
            missing: record.requestedPermissions.filter((item) => !record.approvedPermissions.includes(item)),
          },
          diagnostics: validation.diagnostics,
        });
      }
      return { plugins, warnings: [] };
    },
    async setEnabled({ id, cwd, enabled }) {
      let changed = false;
      await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
        for (const record of Object.values(store.plugins)) {
          if (record.id !== id || !applies(record, cwd)) continue;
          if (record.scope === "managed") throw new Error(`Managed plugin cannot be modified: ${id}`);
          record.enabled = enabled;
          record.updatedAt = new Date().toISOString();
          changed = true;
        }
        if (!changed) throw new Error(`Plugin not found for cwd: ${id}`);
      });
      return { message: `${enabled ? "Enabled" : "Disabled"} plugin '${id}'.`, restartRuntimes: true };
    },
    async installLocal(input) {
      const result = await installLocalNativePlugin(input);
      if (result.status !== "installed") throw new Error(result.diagnostics.map((item) => item.message).join("; "));
      return { message: `Installed plugin '${result.record.id}'.`, restartRuntimes: true };
    },
    async uninstall({ id, cwd }) {
      let changed = false;
      await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
        for (const [key, record] of Object.entries(store.plugins)) {
          if (record.id !== id || !applies(record, cwd)) continue;
          if (record.scope === "managed") throw new Error(`Managed plugin cannot be removed: ${id}`);
          delete store.plugins[key];
          changed = true;
        }
        if (!changed) throw new Error(`Plugin not found for cwd: ${id}`);
      });
      return { message: `Uninstalled plugin '${id}' (plugin data retained).`, restartRuntimes: true };
    },
  };
}
