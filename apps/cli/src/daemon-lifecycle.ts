import type { DaemonRegistry } from "@openharness/server";

export type DaemonProbeStatus = "ready" | "stale" | "unreachable";

export interface DaemonProbeOptions {
  fetch?: typeof fetch;
  pidAlive?: (pid: number) => boolean;
  timeoutMs?: number;
  expectedVersion?: string;
  minimumStartedAt?: number;
}

export function daemonPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function probeDaemonRegistry(
  registry: DaemonRegistry,
  options: DaemonProbeOptions = {},
): Promise<DaemonProbeStatus> {
  const pidAlive = options.pidAlive ?? daemonPidAlive;
  if (!pidAlive(registry.pid)) return "unreachable";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_000);
  try {
    const fetchImpl = options.fetch ?? fetch;
    const response = await fetchImpl(`${registry.url.replace(/\/+$/, "")}/health`, {
      headers: { authorization: `Bearer ${registry.token}` },
      signal: controller.signal,
    });
    if (!response.ok) return "unreachable";
    const health = await response.json() as { ok?: unknown; version?: unknown };
    if (health.ok !== true) return "unreachable";

    if (options.expectedVersion && (
      registry.version !== options.expectedVersion || health.version !== options.expectedVersion
    )) return "stale";
    if (options.minimumStartedAt && registry.startedAt < options.minimumStartedAt) return "stale";
    return "ready";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

export function terminateDaemonProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
