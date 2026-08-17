import { loadSettings, type Settings } from "@openharness/core";
import {
  resolveSandboxPolicy,
  validateSandboxPath,
  type SandboxOperation,
  type SandboxPathValidationResult,
} from "@openharness/sandbox";

export async function sandboxPathDecision(
  filePath: string,
  cwd: string,
  operation: SandboxOperation,
  settingsOverride?: Settings,
): Promise<SandboxPathValidationResult | undefined> {
  const settings = settingsOverride ?? await loadSettings();
  const policy = resolveSandboxPolicy({ cwd, settings });
  if (!policy.enabled) return undefined;

  return validateSandboxPath(filePath, {
    sandboxRoot: cwd,
    operation,
    policy,
  });
}

export async function sandboxPathError(
  filePath: string,
  cwd: string,
  operation: SandboxOperation,
  settingsOverride?: Settings,
): Promise<string | undefined> {
  const result = await sandboxPathDecision(filePath, cwd, operation, settingsOverride);
  if (!result) return undefined;
  return result.allowed ? undefined : `Sandbox: ${result.reason}`;
}
