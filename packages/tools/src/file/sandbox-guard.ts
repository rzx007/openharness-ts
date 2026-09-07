import { loadSettings, type Settings } from "@openharness/core";
import type { ExecutionEnvironmentHandle } from "@openharness/environment";
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
  environment?: ExecutionEnvironmentHandle,
): Promise<string | undefined> {
  if (environment) {
    const result = await environment.paths.resolve(filePath, operation);
    if (environment.info.kind === "docker" && result.mountPurpose === "unmounted") {
      return `Sandbox: path is outside the mounted execution roots: ${result.executionPath}`;
    }
    if (operation === "write" && result.mountMode === "ro") {
      return `Sandbox: path is on a read-only mount: ${result.executionPath}`;
    }
    return undefined;
  }
  const result = await sandboxPathDecision(filePath, cwd, operation, settingsOverride);
  if (!result) return undefined;
  return result.allowed ? undefined : `Sandbox: ${result.reason}`;
}
