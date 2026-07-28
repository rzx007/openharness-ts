import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { resolve } from "node:path";
import { loadSettings, type Settings } from "@openharness/core";
import { getSrtAvailability } from "./availability.js";
import { SandboxUnavailableError } from "./docker-backend.js";
import { normalizeSandboxConfig } from "./config.js";
import { getActiveSandboxSession } from "./session.js";
import { wrapCommandForSrt } from "./srt-adapter.js";

export interface CreateShellProcessOptions {
  cwd: string;
  settings?: Settings;
  env?: Record<string, string>;
  stdio?: StdioOptions;
}

type HostShellLauncher =
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
  const settings = options.settings ?? await loadSettings();
  const sandbox = normalizeSandboxConfig(settings.sandbox);

  if (!sandbox.enabled) {
    return spawnHost(resolveShellArgv(command), options);
  }

  if (sandbox.backend === "docker") {
    // Container image is Linux; never reuse host (e.g. Windows bash.exe) argv.
    const argv = resolveContainerShellArgv(command);
    const session = getActiveSandboxSession();
    if (session?.backend === "docker" && session.active && session.execCommand) {
      return session.execCommand(argv, {
        cwd: options.cwd,
        settings,
        env: options.env,
        stdio: options.stdio,
      });
    }
    if (sandbox.failIfUnavailable) {
      throw new SandboxUnavailableError("Docker sandbox session is not running");
    }
    return spawnHost(resolveShellArgv(command), options);
  }

  const availability = getSrtAvailability(settings.sandbox);
  if (!availability.available) {
    if (sandbox.failIfUnavailable) {
      throw new SandboxUnavailableError(availability.reason ?? "srt sandbox is unavailable");
    }
    return spawnHost(resolveShellArgv(command), options);
  }

  const argv = resolveShellArgv(command);
  const wrapped = await wrapCommandForSrt(argv, settings.sandbox);
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
  return spawn(argv[0]!, argv.slice(1), {
    cwd: resolve(options.cwd),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}
