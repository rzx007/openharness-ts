import { getInstalledPluginStorePath } from "@openharness/core";
import { getNativeToolRuntimeSnapshot } from "@openharness/agent-runtime";
import {
  installLocalNativePlugin,
  loadNativePlugin,
  readInstalledPluginStore,
  updateInstalledPluginStore,
  verifyInstalledNativePlugin,
} from "@openharness/plugins";
import type { PluginInfo, PluginService } from "../settings-api.js";
import type { DaemonSettingsRef } from "./shared.js";

function isGlobalPlugin<T extends { scope: string }>(record: T): record is T & { scope: "user" | "managed" } {
  return record.scope === "user" || record.scope === "managed";
}

export function createDefaultPluginService(_ref: DaemonSettingsRef): PluginService {
  return {
    async list() {
      const store = await readInstalledPluginStore(getInstalledPluginStorePath());
      const plugins: PluginInfo[] = [];
      const warnings: string[] = [];
      for (const record of Object.values(store.plugins)) {
        if (!isGlobalPlugin(record)) {
          warnings.push(`${record.id}: ignored legacy ${record.scope}-scoped installation; reinstall it for the user`);
          continue;
        }
        const verification = await verifyInstalledNativePlugin(record);
        const manifest = verification.plugin?.manifest;
        const loaded = verification.status === "valid" ? await loadNativePlugin(verification.plugin) : undefined;
        const liveTools = getNativeToolRuntimeSnapshot(verification.plugin?.root ?? record.cachePath);
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
          installation: verification.status === "valid" ? "installed" : "invalid",
          activation: record.enabled ? "reload-required" : "inactive",
          ...(manifest?.components.tools ? {
            toolRuntime: {
              state: !record.enabled
                ? "inactive" as const
                : liveTools.hostCount > 0 ? liveTools.state : "reload-required" as const,
              declaredEntries: manifest.components.tools.length,
              activatableEntries: loaded?.components.tools?.value?.length ?? 0,
              hostCount: liveTools.hostCount,
              registeredToolCount: liveTools.registeredToolCount,
              ...(liveTools.lastStartedAt ? { lastStartedAt: liveTools.lastStartedAt } : {}),
              ...(liveTools.lastError ? { lastError: liveTools.lastError } : {}),
            },
          } : {}),
          inventory,
          permissions: {
            requested: record.requestedPermissions,
            approved: record.approvedPermissions,
            missing: record.requestedPermissions.filter((item) => !record.approvedPermissions.includes(item)),
          },
          diagnostics: [...verification.diagnostics, ...(loaded?.diagnostics ?? [])],
        });
      }
      return { plugins, warnings };
    },
    async setEnabled({ id, enabled }) {
      let changed = false;
      await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
        for (const record of Object.values(store.plugins)) {
          if (record.id !== id || !isGlobalPlugin(record)) continue;
          if (record.scope === "managed") throw new Error(`Managed plugin cannot be modified: ${id}`);
          record.enabled = enabled;
          record.updatedAt = new Date().toISOString();
          changed = true;
        }
        if (!changed) throw new Error(`Plugin not found for user: ${id}`);
      });
      return { message: `${enabled ? "Enabled" : "Disabled"} plugin '${id}'.`, restartRuntimes: true };
    },
    async installLocal(input) {
      const result = await installLocalNativePlugin(input);
      if (result.status !== "installed") throw new Error(result.diagnostics.map((item) => item.message).join("; "));
      return { message: `Installed plugin '${result.record.id}'.`, restartRuntimes: true };
    },
    async uninstall({ id }) {
      let changed = false;
      await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
        for (const [key, record] of Object.entries(store.plugins)) {
          if (record.id !== id || !isGlobalPlugin(record)) continue;
          if (record.scope === "managed") throw new Error(`Managed plugin cannot be removed: ${id}`);
          delete store.plugins[key];
          changed = true;
        }
        if (!changed) throw new Error(`Plugin not found for user: ${id}`);
      });
      return { message: `Uninstalled plugin '${id}' (plugin data retained).`, restartRuntimes: true };
    },
  };
}
