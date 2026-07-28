import type { Settings } from "@openharness/core";
import {
  getDockerAvailability,
  getSrtAvailability,
  type AvailabilityDeps,
} from "./availability.js";
import { normalizeSandboxConfig } from "./config.js";
import { DockerSandboxSession, SandboxUnavailableError } from "./docker-backend.js";
import { setActiveSandboxSession } from "./session.js";
import type { SandboxRuntimeStatus } from "./types.js";

export interface SandboxRuntimeOptions {
  settings: Settings;
  cwd: string;
  sessionId: string;
  deps?: AvailabilityDeps;
}

export interface StartedSandboxRuntime {
  status: SandboxRuntimeStatus;
  stop(): Promise<void>;
  stopSync(): void;
}

export async function startSandboxRuntime(
  options: SandboxRuntimeOptions,
): Promise<StartedSandboxRuntime> {
  const sandbox = normalizeSandboxConfig(options.settings.sandbox);

  if (!sandbox.enabled) {
    return inertRuntime({
      state: "off",
      enabled: false,
      active: false,
      backend: sandbox.backend,
    });
  }

  if (sandbox.backend === "srt") {
    const availability = getSrtAvailability(options.settings.sandbox, options.deps);
    if (!availability.available) {
      if (sandbox.failIfUnavailable) {
        throw new SandboxUnavailableError(availability.reason ?? "srt sandbox is unavailable");
      }
      return inertRuntime(statusFromAvailability("unavailable", availability));
    }
    return inertRuntime(statusFromAvailability("active", availability));
  }

  const availability = getDockerAvailability(options.settings.sandbox, options.deps);
  if (!availability.available) {
    if (sandbox.failIfUnavailable) {
      throw new SandboxUnavailableError(availability.reason ?? "Docker sandbox is unavailable");
    }
    return inertRuntime(statusFromAvailability("unavailable", availability));
  }

  const session = new DockerSandboxSession({
    settings: options.settings,
    sessionId: options.sessionId,
    cwd: options.cwd,
    deps: options.deps,
  });
  try {
    await session.start();
  } catch (error) {
    if (sandbox.failIfUnavailable) throw error;
    return inertRuntime(statusFromAvailability("unavailable", {
      ...availability,
      available: false,
      active: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
  }
  setActiveSandboxSession(session);

  const status = statusFromAvailability(
    availability.degraded ? "degraded" : "active",
    availability,
    sandbox,
    {
      containerName: session.containerName,
      containerCwd: session.containerCwd,
    },
  );

  return {
    status,
    async stop() {
      try {
        await session.stop();
      } finally {
        setActiveSandboxSession(null);
      }
    },
    stopSync() {
      try {
        session.stopSync();
      } finally {
        setActiveSandboxSession(null);
      }
    },
  };
}

function inertRuntime(status: SandboxRuntimeStatus): StartedSandboxRuntime {
  return {
    status,
    async stop() {},
    stopSync() {},
  };
}

function statusFromAvailability(
  state: SandboxRuntimeStatus["state"],
  availability: ReturnType<typeof getSrtAvailability>,
  sandbox?: ReturnType<typeof normalizeSandboxConfig>,
  details?: {
    containerName?: string;
    containerCwd?: string;
  },
): SandboxRuntimeStatus {
  return {
    state,
    enabled: availability.enabled,
    active: availability.available,
    backend: availability.backend,
    platform: availability.platform,
    reason: availability.reason,
    degraded: availability.degraded,
    containerName: details?.containerName,
    containerCwd: details?.containerCwd,
    networkMode: sandbox?.network.mode,
    dns: sandbox?.docker.dns,
    proxy: sandbox ? dockerProxyStatus(sandbox.docker.extraEnv) : undefined,
  };
}

function dockerProxyStatus(extraEnv: Record<string, string>): "configured" | "not configured" {
  return extraEnv.HTTP_PROXY || extraEnv.HTTPS_PROXY || extraEnv.http_proxy || extraEnv.https_proxy
    ? "configured"
    : "not configured";
}
