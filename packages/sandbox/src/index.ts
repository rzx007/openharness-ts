export type {
  ResolvedSandboxConfig,
  SandboxAvailability,
  SandboxBackend,
  SandboxNetworkMode,
  SandboxOperation,
  SandboxPathValidationResult,
  SandboxPlatform,
  SandboxRuntimeState,
  SandboxRuntimeStatus,
  SandboxSession,
  ShellSpawnOptions,
  ValidateSandboxPathOptions,
} from "./types.js";
export { normalizeSandboxConfig } from "./config.js";
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
  buildDockerRunArgs,
  dockerContainerName,
  DockerSandboxSession,
  SandboxUnavailableError,
  toContainerWorkspacePath,
} from "./docker-backend.js";
export type { DockerExecArgsOptions, DockerRunArgsOptions } from "./docker-backend.js";
export {
  getActiveSandboxSession,
  isSandboxSessionActive,
  setActiveSandboxSession,
  stopActiveSandboxSession,
  stopActiveSandboxSessionSync,
} from "./session.js";
export {
  createShellProcess,
  resolveContainerShellArgv,
  resolveShellArgv,
  resetHostShellCacheForTests,
} from "./shell.js";
export type { CreateShellProcessOptions } from "./shell.js";
export { startSandboxRuntime } from "./lifecycle.js";
export type { SandboxRuntimeOptions, StartedSandboxRuntime } from "./lifecycle.js";

export interface SandboxConfig {
  runtime?: string;
  image?: string;
  workdir?: string;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class SandboxAdapter {
  constructor(private readonly config: SandboxConfig = {}) {}

  async execute(command: string, _cwd?: string): Promise<SandboxResult> {
    const runtime = this.config.runtime ? ` via ${this.config.runtime}` : "";
    throw new Error(`Sandbox not yet implemented${runtime}. Tried to run: ${command}`);
  }

  isAvailable(): boolean {
    return false;
  }
}
