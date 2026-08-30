import type { OpenHarnessPluginManifestV1 } from "./types.js";

export function buildNativePluginCompatibilityEnvironment(input: {
  manifest: OpenHarnessPluginManifestV1;
  root: string;
  cwd: string;
}): Record<string, string> {
  void input;
  return {};
}
