import type { Settings } from "@openharness/core";
import { getSandboxAvailability as getSandboxAvailabilityInternal } from "./availability.js";
import { createShellProcess as createShellProcessInternal } from "./shell.js";
import { startSandboxRuntime as startSandboxRuntimeInternal } from "./lifecycle.js";

export type {
  ResolvedSandboxConfig,
  SandboxAvailability,
  SandboxBackend,
  SandboxFailureKind,
  SandboxNetworkMode,
  SandboxOperation,
  SandboxPathValidationResult,
  SandboxPolicy,
  SandboxPolicyDenial,
  SandboxPolicyEnforcement,
  SandboxPolicyInput,
  SandboxPolicyMode,
  SandboxPolicyOperation,
  SandboxPolicyScope,
  SandboxPolicyService,
  SandboxPlatform,
  SandboxRuntimeEvent,
  SandboxRuntimeReporter,
  SandboxRuntimeState,
  SandboxRuntimeStatus,
  SandboxSession,
  ShellSpawnOptions,
  ValidateSandboxPathOptions,
} from "./types.js";
export { normalizeSandboxConfig } from "./config.js";
export {
  classifySandboxFailure,
  defaultSandboxPolicyService,
  DefaultSandboxPolicyService,
  resolveSandboxPolicy,
  SandboxPolicyDeniedError,
} from "./policy.js";
export {
  detectSandboxPlatform,
  supportsDockerSandbox,
  supportsSandboxRuntime,
} from "./platform.js";
export { validateSandboxPath } from "./path-validator.js";
export {
  getDockerAvailability,
  getSandboxAvailability,
  getSrtAvailability,
} from "./availability.js";
export type { AvailabilityDeps } from "./availability.js";
export {
  buildSrtRuntimeConfig,
  shellJoin,
  shellQuote,
  wrapCommandForSrt,
} from "./srt-adapter.js";
export type { SrtRuntimeConfig, WrappedSrtCommand } from "./srt-adapter.js";
export {
  buildDockerExecArgs,
  buildDockerBuildArgs,
  buildDockerImageInspectArgs,
  buildDockerRunArgs,
  buildDockerSupervisedArgv,
  DOCKER_CONFIG_HASH_LABEL,
  DOCKER_WORKSPACE_LABEL,
  dockerDefaultDockerfilePath,
  dockerContainerName,
  dockerReusableContainerName,
  dockerSandboxConfigHash,
  dockerNetworkMode,
  DockerSandboxSession,
  hostPathToContainerPath,
  inspectDockerSandbox,
  SandboxUnavailableError,
  toContainerWorkspacePath,
} from "./docker-backend.js";
export type { DockerBuildArgsOptions, DockerExecArgsOptions, DockerRunArgsOptions } from "./docker-backend.js";
export {
  getActiveSandboxSession,
  isSandboxSessionActive,
  setActiveSandboxSession,
  stopActiveSandboxSession,
  stopActiveSandboxSessionSync,
} from "./session.js";
export type { SandboxSessionLookup, SandboxSessionScope } from "./session.js";
export { signalProcessTree, terminateProcessTree } from "./process-control.js";
export type { ProcessSignal } from "./process-control.js";
export {
  createProcess,
  createShellProcess,
  describeHostShellLauncher,
  resolveContainerShellArgv,
  resolveHostShellLauncher,
  resolveShellArgv,
  resetHostShellCacheForTests,
} from "./shell.js";
export type { CreateProcessOptions, CreateShellProcessOptions, HostShellLauncher } from "./shell.js";
export { startSandboxRuntime } from "./lifecycle.js";
export type { SandboxRuntimeOptions, StartedSandboxRuntime } from "./lifecycle.js";

export interface SandboxConfig {
  runtime?: string;
  image?: string;
  workdir?: string;
  enabled?: boolean;
  failIfUnavailable?: boolean;
  networkMode?: "none" | "bridge" | "host" | "proxy";
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class SandboxAdapter {
  constructor(private readonly config: SandboxConfig = {}) {}

  async execute(command: string, _cwd?: string): Promise<SandboxResult> {
    const cwd = _cwd ?? this.config.workdir ?? process.cwd();
    const settings = this.toSettings();
    const sessionId = `adapter-${process.pid}-${Date.now().toString(36)}`;
    const runtime = await startSandboxRuntimeInternal({
      settings,
      cwd,
      sessionId,
    });

    try {
      return await runAdapterCommand(command, cwd, settings, sessionId);
    } finally {
      await runtime.stop();
    }
  }

  isAvailable(): boolean {
    return getSandboxAvailabilityInternal(this.toSettings().sandbox).available;
  }

  private toSettings(): Settings {
    const backend = this.config.runtime === "docker" || this.config.runtime === "srt"
      ? this.config.runtime
      : undefined;
    return {
      model: "sandbox-adapter",
      apiFormat: "openai",
      maxTurns: 1,
      permission: { mode: "default" },
      sandbox: {
        enabled: this.config.enabled ?? backend !== undefined,
        backend,
        failIfUnavailable: this.config.failIfUnavailable ?? false,
        network: this.config.networkMode ? { mode: this.config.networkMode } : undefined,
        docker: this.config.image ? { image: this.config.image } : undefined,
      },
    };
  }
}

function runAdapterCommand(
  command: string,
  cwd: string,
  settings: Settings,
  sessionId: string,
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    createShellProcessInternal(command, {
      cwd,
      sessionId,
      settings,
      stdio: ["ignore", "pipe", "pipe"],
    }).then((child) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        resolve({ exitCode: 1, stdout, stderr: stderr || error.message });
      });
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    }).catch((error) => {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
