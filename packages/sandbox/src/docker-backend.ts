import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxConfig } from "@openharness/core";
import { getDockerAvailability, type AvailabilityDeps } from "./availability.js";
import { normalizeSandboxConfig } from "./config.js";
import {
  bindProcessAbortSignal,
  registerManagedProcess,
  type ProcessSignal,
} from "./process-control.js";
import type { SandboxRuntimeReporter, ShellSpawnOptions } from "./types.js";

export class SandboxUnavailableError extends Error {
  readonly failureKind = "runner" as const;

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
  workspaceRoot?: string;
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

export interface DockerSandboxDiagnostics {
  containerName: string;
  expectedConfigHash: string;
  dockerfile: string;
  dockerfileFound: boolean;
  image: string;
  imageExists: boolean;
  containerExists: boolean;
  containerRunning: boolean;
  containerConfigHash: string;
  containerConfigMatches: boolean | undefined;
}

export const DOCKER_CONFIG_HASH_LABEL = "org.openharness.sandbox.config-hash";
export const DOCKER_WORKSPACE_LABEL = "org.openharness.sandbox.workspace";
const DOCKER_EXEC_STATE_DIR = "/tmp/openharness-exec";
const DOCKER_SUPERVISOR_VERSION = "docker-init-v1";

const DOCKER_EXEC_SUPERVISOR = `
marker="$1"
cancel="$2"
shift 2
if [ -f "$cancel" ]; then
  rm -f "$marker" "$cancel"
  exit 143
fi
setsid_bin=/usr/bin/setsid
if [ ! -x "$setsid_bin" ]; then setsid_bin=/bin/setsid; fi
if [ ! -x "$setsid_bin" ]; then setsid_bin=setsid; fi
"$setsid_bin" "$@" &
pid=$!
printf '%s\n' "$pid" > "$marker"
if [ -f "$cancel" ]; then
  /bin/kill -TERM -- "-$pid" 2>/dev/null || true
fi
wait "$pid"
status=$?
rm -f "$marker" "$cancel"
exit "$status"
`.trim();

const DOCKER_EXEC_STDIN_SUPERVISOR = `
marker="$1"
cancel="$2"
shift 2
if [ -f "$cancel" ]; then
  rm -f "$marker" "$cancel"
  exit 143
fi
setsid_bin=/usr/bin/setsid
if [ ! -x "$setsid_bin" ]; then setsid_bin=/bin/setsid; fi
if [ ! -x "$setsid_bin" ]; then setsid_bin=setsid; fi
exec "$setsid_bin" /bin/sh -c '
marker="$1"
cancel="$2"
shift 2
printf "%s\\n" "$$" > "$marker"
if [ -f "$cancel" ]; then
  rm -f "$marker" "$cancel"
  exit 143
fi
"$@"
status=$?
rm -f "$marker" "$cancel"
exit "$status"
' openharness-child "$marker" "$cancel" "$@"
`.trim();

const DOCKER_EXEC_STOPPER = `
marker="$1"
cancel="$2"
signal="$3"
: > "$cancel"
i=0
while [ ! -s "$marker" ] && [ -f "$cancel" ] && [ "$i" -lt 100 ]; do
  sleep 0.05
  i=$((i + 1))
done
if [ -s "$marker" ]; then
  pid=$(cat "$marker")
  /bin/kill "-$signal" -- "-$pid" 2>/dev/null || true
  if [ "$signal" != "KILL" ]; then
    i=0
    while /bin/kill -0 -- "-$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
      sleep 0.05
      i=$((i + 1))
    done
    /bin/kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$marker" "$cancel"
fi
`.trim();

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
    "--init",
    "--name",
    containerName,
    "--network",
    dockerNetworkMode(config.network.mode),
  ];
  if (!config.docker.reuseContainer) {
    argv.splice(3, 0, "--rm");
  }
  argv.push(
    "--label",
    `${DOCKER_CONFIG_HASH_LABEL}=${dockerSandboxConfigHash(config, cwd)}`,
    "--label",
    `${DOCKER_WORKSPACE_LABEL}=${cwd}`,
  );

  if (config.docker.cpuLimit > 0) {
    argv.push("--cpus", String(config.docker.cpuLimit));
  }
  if (config.docker.memoryLimit) {
    argv.push("--memory", config.docker.memoryLimit);
  }
  for (const dns of config.docker.dns) {
    argv.push("--dns", dns);
  }

  argv.push(
    "-v",
    `${cwd}:${containerCwd}${isDockerReadOnlyFilesystem(config) ? ":ro" : ""}`,
    "-w",
    containerCwd,
  );

  for (const mount of config.docker.extraMounts) {
    argv.push("-v", mount);
  }
  for (const [key, value] of Object.entries(config.docker.extraEnv)) {
    argv.push("-e", `${key}=${value}`);
  }

  argv.push(config.docker.image, "tail", "-f", "/dev/null");
  return argv;
}

/** Mirror policy.ts: empty write roots ⇒ read-only workspace mount. */
function isDockerReadOnlyFilesystem(
  config: ReturnType<typeof normalizeSandboxConfig>,
): boolean {
  return (
    config.filesystem.allowWrite.length === 0 &&
    config.filesystem.extraAllowedRoots.length === 0
  );
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
    "-i",
    "-w",
    hostPathToContainerPath(cwd, options.workspaceRoot ?? cwd),
  ];
  for (const [key, value] of Object.entries(containerExecEnv(options.env))) {
    argv.push("-e", `${key}=${value}`);
  }
  argv.push(options.containerName, ...options.argv);
  return argv;
}

/** Wrap one Docker command in a process group that can be stopped from the host. */
export function buildDockerSupervisedArgv(
  argv: string[],
  executionId: string,
  options: { preserveStdin?: boolean } = {},
): string[] {
  const { marker, cancel } = dockerExecutionStatePaths(executionId);
  return [
    "/bin/sh",
    "-c",
    options.preserveStdin ? DOCKER_EXEC_STDIN_SUPERVISOR : DOCKER_EXEC_SUPERVISOR,
    "openharness-exec",
    marker,
    cancel,
    ...argv,
  ];
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
  private readonly activeExecutions = new Map<string, {
    child: ChildProcess;
    nativeKill: ChildProcess["kill"];
  }>();
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

  get cwd(): string {
    return resolve(this.options.cwd);
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
      await assertReusableContainerMatchesConfig({
        dockerCommand: this.dockerCommand,
        containerName: this.containerName,
        expectedHash: dockerSandboxConfigHash(config, resolve(this.options.cwd)),
      });
      this.options.reporter?.({ type: "start-container", containerName: this.containerName, reused: true });
      const wasRunning = await dockerContainerRunning(this.dockerCommand, this.containerName);
      if (!wasRunning) {
        await runToCompletion([this.dockerCommand, "start", this.containerName]);
      }
      try {
        await this.assertProcessSupervisorAvailable();
        this.running = true;
      } catch (error) {
        if (!wasRunning) {
          await runToCompletion([this.dockerCommand, "stop", "-t", "1", this.containerName]).catch(() => {});
        }
        this.running = false;
        throw error;
      }
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
    try {
      await this.assertProcessSupervisorAvailable();
      this.running = true;
    } catch (error) {
      await runToCompletion([this.dockerCommand, "rm", "-f", this.containerName]).catch(() => {});
      this.running = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    const config = normalizeSandboxConfig(this.options.settings.sandbox);
    await Promise.all([...this.activeExecutions.entries()].map(async ([executionId, execution]) => {
      await stopDockerExecution({
        dockerCommand: this.dockerCommand,
        containerName: this.containerName,
        executionId,
        signal: "SIGKILL",
      }).catch(() => {});
      if (execution.child.exitCode === null && execution.child.signalCode === null) {
        execution.nativeKill("SIGKILL");
      }
    }));
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
    for (const [executionId, execution] of this.activeExecutions) {
      stopDockerExecutionSync({
        dockerCommand: this.dockerCommand,
        containerName: this.containerName,
        executionId,
      });
      if (execution.child.exitCode === null && execution.child.signalCode === null) {
        execution.nativeKill("SIGKILL");
      }
    }
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
    const executionId = randomUUID().replaceAll("-", "");
    const execArgs = buildDockerExecArgs({
      containerName: this.containerName,
      cwd: options.cwd,
      workspaceRoot: this.cwd,
      argv: buildDockerSupervisedArgv(argv, executionId, { preserveStdin: usesStdinPipe(options.stdio) }),
      env: options.env,
      dockerCommand: this.dockerCommand,
    });
    const child = spawn(execArgs[0]!, execArgs.slice(1), spawnOptions(options));
    const nativeKill = child.kill.bind(child);
    this.activeExecutions.set(executionId, { child, nativeKill });
    const cleanup = () => this.activeExecutions.delete(executionId);
    child.once("close", cleanup);
    child.once("error", cleanup);
    registerManagedProcess(child, (signal) => {
      return stopDockerExecution({
        dockerCommand: this.dockerCommand,
        containerName: this.containerName,
        executionId,
        signal,
      }).catch(() => {}).finally(() => {
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) nativeKill("SIGKILL");
        }, 100).unref?.();
      });
    });
    bindProcessAbortSignal(child, options.signal);
    return child;
  }

  private async assertProcessSupervisorAvailable(): Promise<void> {
    const available = await runProbe([
      this.dockerCommand,
      "exec",
      this.containerName,
      "/bin/sh",
      "-c",
      `mkdir -p ${DOCKER_EXEC_STATE_DIR} && command -v setsid >/dev/null 2>&1 && command -v sleep >/dev/null 2>&1 && test -x /bin/kill`,
    ]);
    if (!available) {
      throw new SandboxUnavailableError(
        "Docker sandbox image must provide setsid, sleep, and /bin/kill so stopped tasks cannot keep running",
      );
    }
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

  const dockerfile = dockerDefaultDockerfilePath();
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

export function dockerDefaultDockerfilePath(): string {
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

export function dockerSandboxConfigHash(
  config: ReturnType<typeof normalizeSandboxConfig>,
  cwd: string,
): string {
  const payload = {
    cwd: resolve(cwd),
    containerCwd: toContainerWorkspacePath(cwd),
    network: config.network.mode,
    image: config.docker.image,
    cpuLimit: config.docker.cpuLimit,
    memoryLimit: config.docker.memoryLimit,
    dns: [...config.docker.dns].sort(),
    extraMounts: [...config.docker.extraMounts].sort(),
    extraEnv: stableRecord(config.docker.extraEnv),
    supervisorVersion: DOCKER_SUPERVISOR_VERSION,
  };
  return createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export async function inspectDockerSandbox(options: {
  config?: SandboxConfig;
  cwd: string;
  dockerCommand?: string;
}): Promise<DockerSandboxDiagnostics> {
  const config = normalizeSandboxConfig(options.config);
  const cwd = resolve(options.cwd);
  const dockerCommand = options.dockerCommand ?? "docker";
  const containerName = config.docker.reuseContainer
    ? dockerReusableContainerName(cwd, config.docker.containerNamePrefix)
    : dockerContainerName("session", config.docker.containerNamePrefix);
  const expectedConfigHash = dockerSandboxConfigHash(config, cwd);
  const dockerfile = dockerDefaultDockerfilePath();
  const containerExists = await dockerContainerExists(dockerCommand, containerName);
  const containerConfigHash = containerExists
    ? await dockerContainerLabel(dockerCommand, containerName, DOCKER_CONFIG_HASH_LABEL)
    : "";

  return {
    containerName,
    expectedConfigHash,
    dockerfile,
    dockerfileFound: existsSync(dockerfile),
    image: config.docker.image,
    imageExists: await runProbe(buildDockerImageInspectArgs(config.docker.image, dockerCommand)),
    containerExists,
    containerRunning: containerExists
      ? await dockerContainerRunning(dockerCommand, containerName)
      : false,
    containerConfigHash,
    containerConfigMatches: containerExists && containerConfigHash
      ? containerConfigHash === expectedConfigHash
      : undefined,
  };
}

export function toContainerWorkspacePath(hostPath: string): string {
  return process.platform === "win32" ? "/workspace" : hostPath;
}

export function hostPathToContainerPath(hostPath: string, workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(hostPath);
  if (process.platform !== "win32") return target;
  const rel = relative(root, target).replace(/\\/g, "/");
  if (!rel || rel === ".") return "/workspace";
  if (rel.startsWith("../") || rel === ".." || /^[a-zA-Z]:/.test(rel)) {
    throw new SandboxUnavailableError(`Docker sandbox cannot map path outside the workspace: ${target}`);
  }
  return `/workspace/${rel}`;
}

function spawnOptions(options: ShellSpawnOptions): SpawnOptions {
  return {
    cwd: resolve(options.cwd),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    stdio: options.stdio,
    detached: options.detached,
  };
}

function usesStdinPipe(stdio: ShellSpawnOptions["stdio"]): boolean {
  return stdio === "pipe" || (Array.isArray(stdio) && stdio[0] === "pipe");
}

function containerExecEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
}

function dockerExecutionStatePaths(executionId: string): { marker: string; cancel: string } {
  const safeId = executionId.replace(/[^a-zA-Z0-9_.-]/g, "");
  return {
    marker: `${DOCKER_EXEC_STATE_DIR}/${safeId}.pid`,
    cancel: `${DOCKER_EXEC_STATE_DIR}/${safeId}.cancel`,
  };
}

function dockerSignalName(signal: ProcessSignal): string {
  if (typeof signal === "number") return String(signal);
  return /^SIG[A-Z0-9]+$/.test(signal) ? signal.slice(3) : "TERM";
}

async function stopDockerExecution(options: {
  dockerCommand: string;
  containerName: string;
  executionId: string;
  signal: ProcessSignal;
}): Promise<void> {
  const { marker, cancel } = dockerExecutionStatePaths(options.executionId);
  await runToCompletion([
    options.dockerCommand,
    "exec",
    options.containerName,
    "/bin/sh",
    "-c",
    `mkdir -p ${DOCKER_EXEC_STATE_DIR}; ${DOCKER_EXEC_STOPPER}`,
    "openharness-stop",
    marker,
    cancel,
    dockerSignalName(options.signal),
  ]);
}

function stopDockerExecutionSync(options: {
  dockerCommand: string;
  containerName: string;
  executionId: string;
}): void {
  const { marker, cancel } = dockerExecutionStatePaths(options.executionId);
  spawnSync(options.dockerCommand, [
    "exec",
    options.containerName,
    "/bin/sh",
    "-c",
    `mkdir -p ${DOCKER_EXEC_STATE_DIR}; ${DOCKER_EXEC_STOPPER}`,
    "openharness-stop",
    marker,
    cancel,
    "KILL",
  ], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 3000,
  });
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

async function assertReusableContainerMatchesConfig(options: {
  dockerCommand: string;
  containerName: string;
  expectedHash: string;
}): Promise<void> {
  const existingHash = await dockerContainerLabel(
    options.dockerCommand,
    options.containerName,
    DOCKER_CONFIG_HASH_LABEL,
  );
  if (existingHash === options.expectedHash) return;
  throw new SandboxUnavailableError(
    `Reusable Docker sandbox container ${options.containerName} was created with a different sandbox configuration. Run 'ohs sandbox rebuild' to recreate it.`,
  );
}

function dockerContainerExists(dockerCommand: string, containerName: string): Promise<boolean> {
  return runProbe([dockerCommand, "container", "inspect", containerName]);
}

function dockerContainerLabel(
  dockerCommand: string,
  containerName: string,
  label: string,
): Promise<string> {
  return new Promise<string>((resolvePromise) => {
    const child = spawn(dockerCommand, [
      "container",
      "inspect",
      "-f",
      `{{ index .Config.Labels "${label}" }}`,
      containerName,
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolvePromise(""));
    child.on("close", (code) => resolvePromise(code === 0 ? stdout.trim() : ""));
  });
}

function stableRecord(record: Record<string, string>): Array<[string, string]> {
  return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
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
