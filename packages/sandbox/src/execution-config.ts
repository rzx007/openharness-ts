import type { Settings } from "@openharness/core";

import { normalizeSandboxConfig } from "./config.js";
import type { ResolvedSandboxConfig } from "./types.js";

export type ExecutionSurface = "desktop_managed" | "cli_advanced";

export interface ResolveExecutionEnvironmentConfigInput {
  surface: ExecutionSurface;
  settings: Settings;
  cwd: string;
}

export type ResolvedExecutionEnvironmentConfig =
  | {
      mode: "wsl";
      kind: "wsl";
      backend?: undefined;
      failClosed: true;
      cwd: string;
      sandbox: ResolvedSandboxConfig;
    }
  | {
      mode: "local";
      kind: "local";
      backend?: undefined;
      failClosed: false;
      cwd: string;
      sandbox: ResolvedSandboxConfig;
    }
  | {
      mode: "docker";
      kind: "docker";
      backend: "docker";
      failClosed: true;
      cwd: string;
      sandbox: ResolvedSandboxConfig;
    }
  | {
      mode: "legacy_srt";
      kind: "local";
      backend: "srt";
      failClosed: boolean;
      cwd: string;
      sandbox: ResolvedSandboxConfig;
    };

export class ExecutionConfigError extends Error {
  constructor(
    readonly code:
      | "unsupported_srt"
      | "extra_mounts_forbidden",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionConfigError";
  }
}

export function resolveExecutionEnvironmentConfig(
  input: ResolveExecutionEnvironmentConfigInput,
): ResolvedExecutionEnvironmentConfig {
  const sandbox = normalizeSandboxConfig(input.settings.sandbox);

  if (input.settings.agentEnvironment) {
    if (input.settings.agentEnvironment.kind === "wsl") {
      if (sandbox.enabled) {
        throw new ExecutionConfigError(
          "unsupported_srt",
          "WSL cannot currently be combined with the configured local sandbox",
        );
      }
      return { mode: "wsl", kind: "wsl", failClosed: true, cwd: input.cwd, sandbox };
    }
    return { mode: "local", kind: "local", failClosed: false, cwd: input.cwd, sandbox };
  }

  if (input.surface === "desktop_managed") {
    if (sandbox.enabled && sandbox.backend === "srt") {
      throw new ExecutionConfigError(
        "unsupported_srt",
        "Desktop does not support the configured SRT environment",
      );
    }
    if (sandbox.docker.extraMounts.length > 0) {
      throw new ExecutionConfigError(
        "extra_mounts_forbidden",
        "Desktop managed Docker does not allow extraMounts",
      );
    }
  }

  if (!sandbox.enabled) {
    return {
      mode: "local",
      kind: "local",
      failClosed: false,
      cwd: input.cwd,
      sandbox,
    };
  }

  if (sandbox.backend === "srt") {
    return {
      mode: "legacy_srt",
      kind: "local",
      backend: "srt",
      failClosed: sandbox.failIfUnavailable,
      cwd: input.cwd,
      sandbox,
    };
  }

  return {
    mode: "docker",
    kind: "docker",
    backend: "docker",
    failClosed: true,
    cwd: input.cwd,
    sandbox: { ...sandbox, failIfUnavailable: true },
  };
}
