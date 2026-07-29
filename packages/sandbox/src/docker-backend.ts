import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxConfig } from "@openharness/core";
import { getDockerAvailability, type AvailabilityDeps } from "./availability.js";
import { normalizeSandboxConfig } from "./config.js";
import type { SandboxRuntimeReporter, ShellSpawnOptions } from "./types.js";

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

export interface DockerBuildArgsOptions {
  image: string;
  dockerfile: string;
  context: string;
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
  const containerName = config.docker.reuseContainer
    ? dockerReusableContainerName(cwd, config.docker.containerNamePrefix)
    : dockerContainerName(options.sessionId, config.docker.containerNamePrefix);
  const argv = [
    options.dockerCommand ?? "docker",
    "run",
    "-d",
    "--name",
    containerName,
    "--network",
    dockerNetworkMode(config.network.mode),
  ];
  if (!config.docker.reuseContainer) {
    argv.splice(3, 0, "--rm");
  }

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

export function buildDockerImageInspectArgs(image: string, dockerCommand = "docker"): string[] {
  return [dockerCommand, "image", "inspect", image];
}

export function buildDockerBuildArgs(options: DockerBuildArgsOptions): string[] {
  return [
    options.dockerCommand ?? "docker",
    "build",
    "-t",
    options.image,
    "-f",
    options.dockerfile,
    options.context,
  ];
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
      reporter?: SandboxRuntimeReporter;
    },
  ) {
    const config = normalizeSandboxConfig(options.settings.sandbox);
    const cwd = resolve(options.cwd);
    this.containerName = config.docker.reuseContainer
      ? dockerReusableContainerName(cwd, config.docker.containerNamePrefix)
      : dockerContainerName(options.sessionId, config.docker.containerNamePrefix);
    this.containerCwd = toContainerWorkspacePath(cwd);
  }

  get active(): boolean {
    return this.running;
  }

  get backend(): "docker" {
    return "docker";
  }

  async start(): Promise<void> {
    const config = normalizeSandboxConfig(this.options.settings.sandbox);
    const availability = getDockerAvailability(this.options.settings.sandbox, this.options.deps);
    if (!availability.available) {
      throw new SandboxUnavailableError(availability.reason ?? "Docker sandbox is unavailable");
    }
    this.dockerCommand = availability.command ?? "docker";
    await ensureDockerImage({
      config,
      dockerCommand: this.dockerCommand,
      reporter: this.options.reporter,
    });
    if (config.docker.reuseContainer && await dockerContainerExists(this.dockerCommand, this.containerName)) {
      this.options.reporter?.({ type: "start-container", containerName: this.containerName, reused: true });
      if (!await dockerContainerRunning(this.dockerCommand, this.containerName)) {
        await runToCompletion([this.dockerCommand, "start", this.containerName]);
      }
      this.running = true;
      return;
    }
    this.options.reporter?.({
      type: "start-container",
      containerName: this.containerName,
      reused: false,
    });
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
    const config = normalizeSandboxConfig(this.options.settings.sandbox);
    if (config.docker.reuseContainer) {
      this.running = false;
      return;
    }
    try {
      await runToCompletion([this.dockerCommand, "stop", "-t", "5", this.containerName]);
    } finally {
      this.running = false;
    }
  }

  stopSync(): void {
    if (!this.running) return;
    const config = normalizeSandboxConfig(this.options.settings.sandbox);
    if (config.docker.reuseContainer) {
      this.running = false;
      return;
    }
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

async function ensureDockerImage(options: {
  config: ReturnType<typeof normalizeSandboxConfig>;
  dockerCommand: string;
  reporter?: SandboxRuntimeReporter;
}): Promise<void> {
  options.reporter?.({ type: "check-image", image: options.config.docker.image });
  if (await runProbe(buildDockerImageInspectArgs(options.config.docker.image, options.dockerCommand))) {
    return;
  }

  if (!options.config.docker.autoBuildImage) {
    throw new SandboxUnavailableError(
      `Docker image ${options.config.docker.image} is not available and autoBuildImage is disabled`,
    );
  }

  const dockerfile = defaultDockerfilePath();
  if (!existsSync(dockerfile)) {
    throw new SandboxUnavailableError(
      `Docker image ${options.config.docker.image} is not available and no sandbox Dockerfile was found. Checked: ${dockerfile}`,
    );
  }

  options.reporter?.({
    type: "build-image",
    image: options.config.docker.image,
    dockerfile,
  });
  await runToCompletion(buildDockerBuildArgs({
    image: options.config.docker.image,
    dockerfile,
    context: dirname(dockerfile),
    dockerCommand: options.dockerCommand,
  }));
}

function defaultDockerfilePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "Dockerfile"),
    resolve(here, "..", "..", "..", "packages", "sandbox", "Dockerfile"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates.join(", ");
}

export function dockerContainerName(sessionId: string, prefix = "openharness-sandbox"): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 64);
  return `${prefix}-${safeId || "session"}`;
}

export function dockerReusableContainerName(projectRoot: string, prefix = "openharness-sandbox"): string {
  const root = resolve(projectRoot);
  const normalized = process.platform === "win32" ? root.toLowerCase() : root;
  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  const name = basename(root).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32) || "workspace";
  return `${prefix}-${name}-${digest}`;
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

async function runProbe(argv: string[]): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });
}

function dockerContainerExists(dockerCommand: string, containerName: string): Promise<boolean> {
  return runProbe([dockerCommand, "container", "inspect", containerName]);
}

async function dockerContainerRunning(dockerCommand: string, containerName: string): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const child = spawn(dockerCommand, [
      "container",
      "inspect",
      "-f",
      "{{.State.Running}}",
      containerName,
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0 && stdout.trim() === "true"));
  });
}
