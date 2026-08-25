import { getPluginDataDir } from "@openharness/core";
import { join, resolve } from "node:path";
import type { OpenHarnessPluginManifestV1 } from "./types.js";

export function buildNativePluginCompatibilityEnvironment(input: {
  manifest: OpenHarnessPluginManifestV1;
  root: string;
  cwd: string;
}): Record<string, string> {
  const aliases = input.manifest.compatibility?.environmentAliases;
  if (!Array.isArray(aliases)) return {};
  const allowed: Record<string, string> = {
    CLAUDE_PLUGIN_ROOT: join(input.root, "payload"),
    CLAUDE_PLUGIN_DATA: join(getPluginDataDir(), input.manifest.id),
    CLAUDE_PROJECT_DIR: resolve(input.cwd),
  };
  return Object.fromEntries(aliases.filter((name): name is string => typeof name === "string" && allowed[name] !== undefined).map((name) => [name, allowed[name]!]));
}
