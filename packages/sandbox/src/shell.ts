import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { resolve } from "node:path";
import { loadSettings, type Settings } from "@openharness/core";
import { getSrtAvailability } from "./availability.js";
import { SandboxUnavailableError } from "./docker-backend.js";
import { normalizeSandboxConfig } from "./config.js";
import { bindProcessAbortSignal } from "./process-control.js";
import { getActiveSandboxSession } from "./session.js";
import { wrapCommandForSrt } from "./srt-adapter.js";

export interface CreateShellProcessOptions {
  cwd: string;
  sessionId?: string;
  settings?: Settings;
  env?: Record<string, string>;
  stdio?: StdioOptions;
  signal?: AbortSignal;
  detached?: boolean;
  /** Host-only shell policy. Docker always uses /bin/sh; SRT follows the host platform. */
  hostShell?: "preferred" | "system";
}

export interface CreateProcessOptions extends CreateShellProcessOptions {}

/** Start an argv process through the configured sandbox backend. */
export async function createProcess(
  argv: string[],
  options: CreateProcessOptions,
): Promise<ChildProcess> {
  if (argv.length === 0 || !argv[0]) throw new Error("createProcess requires a non-empty argv");
  const settings = options.settings ?? await loadSettings(undefined, {
    projectRoot: options.cwd,
    includeProject: true,
  });
  return createResolvedProcess(argv, argv, options, settings);
}

export type HostShellLauncher =
  | { kind: "posix-sh" }
  | { kind: "bash"; bin: string }
  | { kind: "powershell"; bin: string }
  | { kind: "cmd"; bin: string };

/** Process-lifetime cache for host shell probes (avoid spawnSync on every Bash call). */
let cachedHostShell: HostShellLauncher | undefined;

export async function createShellProcess(
  command: string,
  options: CreateShellProcessOptions,
): Promise<ChildProcess> {
  const settings = options.settings ?? await loadSettings(undefined, {
    projectRoot: options.cwd,
    includeProject: true,
  });
  const spawnHostOverride = options.hostShell === "system"
    ? () => spawnSystemShell(command, options)
    : undefined;
  return createResolvedProcess(
    options.hostShell === "system" ? resolveSystemShellArgv(command) : resolveShellArgv(command),
    resolveContainerShellArgv(command),
    options,
    settings,
    spawnHostOverride,
  );
}

function resolveSystemShellArgv(command: string): string[] {
  if (process.platform === "win32") return [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", command];
  return [process.env.SHELL || "/bin/sh", "-c", command];
}

async function createResolvedProcess(
  hostArgv: string[],
  containerArgv: string[],
  options: CreateProcessOptions,
  settings: Settings,
  spawnHostOverride?: () => ChildProcess,
): Promise<ChildProcess> {
  const sandbox = normalizeSandboxConfig(settings.sandbox);
  const spawnLocal = () => spawnHostOverride?.() ?? spawnHost(hostArgv, options);
  if (!sandbox.enabled) return spawnLocal();

  if (sandbox.backend === "docker") {
    const session = getActiveSandboxSession({ cwd: options.cwd, sessionId: options.sessionId });
    if (session?.backend === "docker" && session.active && session.execCommand) {
      return session.execCommand(containerArgv, {
        cwd: options.cwd,
        settings,
        env: options.env,
        stdio: options.stdio,
        signal: options.signal,
        detached: options.detached,
      });
    }
    if (sandbox.failIfUnavailable) {
      throw new SandboxUnavailableError("Docker sandbox session is not running");
    }
    return spawnLocal();
  }

  const availability = getSrtAvailability(settings.sandbox);
  if (!availability.available) {
    if (sandbox.failIfUnavailable) {
      throw new SandboxUnavailableError(availability.reason ?? "srt sandbox is unavailable");
    }
    return spawnLocal();
  }

  const wrapped = await wrapCommandForSrt(hostArgv, settings.sandbox);
  const child = spawnHost(wrapped.argv, options);
  const cleanup = () => void wrapped.cleanup();
  child.once("close", cleanup);
  child.once("error", cleanup);
  return child;
}

/** Linux container shell — used for docker exec, independent of host platform. */
export function resolveContainerShellArgv(command: string): string[] {
  return ["/bin/sh", "-c", command];
}

export function resolveHostShellLauncher(): HostShellLauncher {
  return detectHostShell();
}

export function describeHostShellLauncher(shell: HostShellLauncher = resolveHostShellLauncher()): string {
  switch (shell.kind) {
    case "bash":
      return `${shell.bin} -c`;
    case "powershell":
      return `${shell.bin} -NoLogo -NoProfile -Command`;
    case "cmd":
      return `${shell.bin} /d /s /c`;
    case "posix-sh":
      return "/bin/sh -c";
  }
}

/**
 * 解析宿主平台 shell：
 * - Windows：优先 bash.exe（非 login `-c`），否则 PowerShell / cmd
 * - POSIX：`/bin/sh -c`
 *
 * 探测结果进程内缓存；docker 路径请用 {@link resolveContainerShellArgv}。
 */
export function resolveShellArgv(command: string): string[] {
  const shell = detectHostShell();
  switch (shell.kind) {
    case "bash":
      return [shell.bin, "-c", command];
    case "powershell":
      return [shell.bin, "-NoLogo", "-NoProfile", "-Command", command];
    case "cmd":
      return [shell.bin, "/d", "/s", "/c", command];
    case "posix-sh":
      return ["/bin/sh", "-c", command];
  }
}

/** @internal test helper */
export function resetHostShellCacheForTests(): void {
  cachedHostShell = undefined;
}

function detectHostShell(): HostShellLauncher {
  if (cachedHostShell) return cachedHostShell;

  if (process.platform !== "win32") {
    cachedHostShell = { kind: "posix-sh" };
    return cachedHostShell;
  }

  if (isUsableCommand("bash.exe", ["-c", "exit 0"])) {
    cachedHostShell = { kind: "bash", bin: "bash.exe" };
    return cachedHostShell;
  }

  const powershell = process.env.ComSpec?.toLowerCase().includes("powershell")
    ? process.env.ComSpec
    : "powershell.exe";
  if (isUsableCommand(powershell)) {
    cachedHostShell = { kind: "powershell", bin: powershell };
    return cachedHostShell;
  }

  cachedHostShell = { kind: "cmd", bin: process.env.ComSpec ?? "cmd.exe" };
  return cachedHostShell;
}

function isUsableCommand(
  command: string,
  args: string[] = ["-NoLogo", "-NoProfile", "-Command", "exit 0"],
): boolean {
  try {
    const result = spawnSync(command, args, {
      windowsHide: true,
      stdio: "ignore",
      timeout: 3000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function spawnHost(argv: string[], options: CreateShellProcessOptions): ChildProcess {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: resolve(options.cwd),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    detached: options.detached ?? process.platform !== "win32",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  bindProcessAbortSignal(child, options.signal);
  return child;
}

function spawnSystemShell(command: string, options: CreateShellProcessOptions): ChildProcess {
  const child = spawn(command, {
    cwd: resolve(options.cwd),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    detached: options.detached ?? process.platform !== "win32",
    shell: true,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  bindProcessAbortSignal(child, options.signal);
  return child;
}
