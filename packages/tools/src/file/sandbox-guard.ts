import { loadSettings, type Settings } from "@openharness/core";
import { validateSandboxPath, type SandboxOperation } from "@openharness/sandbox";

export async function sandboxPathError(
  filePath: string,
  cwd: string,
  operation: SandboxOperation,
  settingsOverride?: Settings,
): Promise<string | undefined> {
  const settings = settingsOverride ?? await loadSettings();
  if (settings.sandbox?.enabled !== true) return undefined;

  const result = await validateSandboxPath(filePath, {
    sandboxRoot: cwd,
    operation,
    config: settings.sandbox,
  });
  return result.allowed ? undefined : `Sandbox: ${result.reason}`;
}
