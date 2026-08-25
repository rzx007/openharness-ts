import { getInstalledPluginStorePath, getPluginCacheDir } from "@openharness/core";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateNativePlugin } from "../manifest/validate.js";
import type { PluginDiagnostic, } from "../diagnostics.js";
import type { OpenHarnessPluginManifestV1 } from "../types.js";
import { computePluginBehaviorDigest, materializePluginCache } from "./cache.js";
import {
  installedPluginKey,
  updateInstalledPluginStore,
  type InstalledPluginRecord,
  type PluginScope,
} from "./store.js";

export function requestedPluginPermissions(manifest: OpenHarnessPluginManifestV1): string[] {
  const result = new Set<string>();
  for (const [category, permissions] of Object.entries(manifest.permissions ?? {})) {
    for (const permission of permissions ?? []) result.add(`${category}:${permission}`);
  }
  for (const tool of manifest.components.tools ?? []) {
    if (typeof tool !== "string") for (const permission of tool.permissions ?? []) result.add(`tool:${permission}`);
  }
  return [...result].sort();
}

export interface InstallLocalNativePluginInput {
  sourcePath: string;
  scope: Exclude<PluginScope, "managed">;
  cwd: string;
  approvedPermissions: string[];
  cacheDir?: string;
  storePath?: string;
  origin?: "native" | "converted";
  sourceFormat?: string;
  link?: boolean;
}
export type InstallLocalNativePluginResult =
  | { status: "installed"; record: InstalledPluginRecord; diagnostics: PluginDiagnostic[] }
  | { status: "blocked" | "invalid"; diagnostics: PluginDiagnostic[] };

export async function installLocalNativePlugin(input: InstallLocalNativePluginInput): Promise<InstallLocalNativePluginResult> {
  const sourcePath = await realpath(resolve(input.sourcePath));
  const validation = await validateNativePlugin(sourcePath);
  if (validation.status === "invalid" || !validation.plugin) return { status: "invalid", diagnostics: validation.diagnostics };
  const requested = requestedPluginPermissions(validation.plugin.manifest);
  const approved = [...new Set(input.approvedPermissions)].sort();
  const unknown = approved.filter((permission) => !requested.includes(permission));
  const missing = requested.filter((permission) => !approved.includes(permission));
  if (unknown.length || missing.length) return { status: "blocked", diagnostics: [{
    severity: "error", phase: "install", code: "plugin_permissions_not_approved",
    message: `Permission approval mismatch; missing=[${missing.join(", ")}], unknown=[${unknown.join(", ")}]`,
    pluginId: validation.plugin.manifest.id, details: { requested, approved, missing, unknown },
  }] };

  const digest = await computePluginBehaviorDigest(sourcePath);
  const cachePath = input.link
    ? sourcePath
    : await materializePluginCache(
        sourcePath, input.cacheDir ?? getPluginCacheDir(), validation.plugin.manifest.id,
        validation.plugin.manifest.version, digest,
      );
  const copiedValidation = await validateNativePlugin(cachePath);
  if (copiedValidation.status === "invalid") return { status: "invalid", diagnostics: copiedValidation.diagnostics };

  const now = new Date().toISOString();
  let provenance: { sourceFormat: string; converterId: string } | undefined;
  try {
    const raw = JSON.parse(await readFile(join(sourcePath, ".openharness-conversion", "provenance.json"), "utf8")) as Record<string, unknown>;
    if (typeof raw.sourceFormat === "string" && typeof raw.converterId === "string") {
      provenance = { sourceFormat: raw.sourceFormat, converterId: raw.converterId };
    }
  } catch {}
  const projectDir = input.scope === "user" ? undefined : resolve(input.cwd);
  const record: InstalledPluginRecord = {
    id: validation.plugin.manifest.id, scope: input.scope, ...(projectDir ? { projectDir } : {}),
    enabled: true, currentVersion: validation.plugin.manifest.version, cachePath,
    ...(input.link ? { linkedSourcePath: sourcePath } : {}), origin: input.origin ?? (provenance ? "converted" : "native"),
    ...((input.sourceFormat ?? provenance?.sourceFormat) ? { sourceFormat: input.sourceFormat ?? provenance!.sourceFormat } : {}),
    requestedPermissions: requested, approvedPermissions: approved, installedAt: now, updatedAt: now,
  };
  await updateInstalledPluginStore(input.storePath ?? getInstalledPluginStorePath(), (store) => {
    const key = installedPluginKey(record);
    const previous = store.plugins[key];
    store.plugins[key] = previous ? { ...record, installedAt: previous.installedAt } : record;
  });
  return { status: "installed", record, diagnostics: [] };
}
