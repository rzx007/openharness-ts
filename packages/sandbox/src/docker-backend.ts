import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import type { SandboxConfig } from "@openharness/core";
import { getDockerAvailability, type AvailabilityDeps } from "./availability.js";
import { normalizeSandboxConfig } from "./config.js";
import type { ShellSpawnOptions } from "./types.js";

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export interface DockerRunArgsOptions {
  sessionId: string;
  cwd: string;
  config?: SandboxConfig;
  dockerCommand?: string;
}

export interface DockerExecArgsOptions {
  containerName: string;
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  dockerCommand?: string;
}

export function buildDockerRunArgs(options: DockerRunArgsOptions): string[] {
  const config = normalizeSandboxConfig(options.config);
  if (config.network.mode === "proxy" && !hasProxyEnv(config.docker.extraEnv)) {
    throw new SandboxUnavailableError("Docker proxy network mode requires HTTP_PROXY or HTTPS_PROXY");
  }
  if (config.network.mode === "host" && process.platform === "darwin") {
    throw new SandboxUnavailableError("Docker host network mode is not supported on macOS in MVP");
  }

  const hasDomainPolicy = config.network.allowedDomains.length > 0 ||
    config.network.deniedDomains.length > 0;
  if (
    hasDomainPolicy &&
    config.network.strictDomainPolicy &&
    (config.network.mode === "bridge" || config.network.mode === "host")
  ) {
    throw new SandboxUnavailableError(
      `Docker ${config.network.mode} network mode cannot enforce strict domain policy`,
    );
  }

  const cwd = resolve(options.cwd);
  const containerCwd = toContainerWorkspacePath(cwd);
  const containerName = dockerContainerName(options.sessionId, config.docker.containerNamePrefix);
  const argv = [
    options.dockerCommand ?? "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "--network",
    dockerNetworkMode(config.network.mode),
  ];

  if (config.docker.cpuLimit > 0) {
    argv.push("--cpus", String(config.docker.cpuLimit));
  }
  if (config.docker.memoryLimit) {
    argv.push("--memory", config.docker.memoryLimit);
  }
  for (const dns of config.docker.dns) {
    argv.push("--dns", dns);
  }

  argv.push("-v", `${cwd}:${containerCwd}`, "-w", containerCwd);

  for (const mount of config.docker.extraMounts) {
    argv.push("-v", mount);
  }
  for (const [key, value] of Object.entries(config.docker.extraEnv)) {
    argv.push("-e", `${key}=${value}`);
  }

  argv.push(config.docker.image, "tail", "-f", "/dev/null");
  return argv;
}

export function dockerNetworkMode(mode: ReturnType<typeof normalizeSandboxConfig>["network"]["mode"]): string {
  return mode === "proxy" ? "bridge" : mode;
}

export function hasProxyEnv(extraEnv: Record<string, string>): boolean {
  return Boolean(
    extraEnv.HTTP_PROXY ||
      extraEnv.HTTPS_PROXY ||
      extraEnv.http_proxy ||
      extraEnv.https_proxy
  );
}

export function buildDockerExecArgs(options: DockerExecArgsOptions): string[] {
  const cwd = resolve(options.cwd);
  const argv = [
    options.dockerCommand ?? "docker",
    "exec",
    "-w",
    toContainerWorkspacePath(cwd),
  ];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    argv.push("-e", `${key}=${value}`);
  }
  argv.push(options.containerName, ...options.argv);
  return argv;
}

export class DockerSandboxSession {
  private running = false;
  readonly containerName: string;
  readonly containerCwd: string;
  private dockerCommand = "docker";

  constructor(
    private readonly options: {
      settings: { sandbox?: SandboxConfig };
      sessionId: string;
      cwd: string;
      deps?: AvailabilityDeps;
    },
  ) {
    const config = normalizeSandboxConfig(options.settings.sandbox);
    const cwd = resolve(options.cwd);
    this.containerName = dockerContainerName(options.sessionId, config.docker.containerNamePrefix);
    this.containerCwd = toContainerWorkspacePath(cwd);
  }

  get active(): boolean {
    return this.running;
  }

  get backend(): "docker" {
    return "docker";
  }

  async start(): Promise<void> {
    const availability = getDockerAvailability(this.options.settings.sandbox, this.options.deps);
    if (!availability.available) {
      throw new SandboxUnavailableError(availability.reason ?? "Docker sandbox is unavailable");
    }
    this.dockerCommand = availability.command ?? "docker";
    const argv = buildDockerRunArgs({
      sessionId: this.options.sessionId,
      cwd: this.options.cwd,
      config: this.options.settings.sandbox,
      dockerCommand: this.dockerCommand,
    });
    await runToCompletion(argv);
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    try {
      await runToCompletion([this.dockerCommand, "stop", "-t", "5", this.containerName]);
    } finally {
      this.running = false;
    }
  }

  stopSync(): void {
    if (!this.running) return;
    try {
      spawnSync(this.dockerCommand, ["stop", "-t", "3", this.containerName], {
        windowsHide: true,
        stdio: "ignore",
      });
    } finally {
      this.running = false;
    }
  }

  async execCommand(argv: string[], options: ShellSpawnOptions): Promise<ChildProcess> {
    if (!this.running) {
      throw new SandboxUnavailableError("Docker sandbox session is not running");
    }
    const execArgs = buildDockerExecArgs({
      containerName: this.containerName,
      cwd: options.cwd,
      argv,
      env: options.env,
      dockerCommand: this.dockerCommand,
    });
    return spawn(execArgs[0]!, execArgs.slice(1), spawnOptions(options));
  }
}

export function dockerContainerName(sessionId: string, prefix = "openharness-sandbox"): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 64);
  return `${prefix}-${safeId || "session"}`;
}

export function toContainerWorkspacePath(hostPath: string): string {
  return process.platform === "win32" ? "/workspace" : hostPath;
}

function spawnOptions(options: ShellSpawnOptions): SpawnOptions {
  return {
    cwd: resolve(options.cwd),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    stdio: options.stdio,
  };
}

async function runToCompletion(argv: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk) => {
      stderr.push(Buffer.from(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        reject(new SandboxUnavailableError(
          message ? `${argv[0]} exited with code ${code}: ${message}` : `${argv[0]} exited with code ${code}`,
        ));
      }
    });
  });
}
