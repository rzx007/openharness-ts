import type { Settings } from "@openharness/core";
import {
  getDockerAvailability,
  getSrtAvailability,
  type AvailabilityDeps,
} from "./availability.js";
import { normalizeSandboxConfig } from "./config.js";
import { DockerSandboxSession, SandboxUnavailableError } from "./docker-backend.js";
import { setActiveSandboxSession } from "./session.js";
import type { SandboxRuntimeReporter, SandboxRuntimeStatus } from "./types.js";

export interface SandboxRuntimeOptions {
  settings: Settings;
  cwd: string;
  sessionId: string;
  deps?: AvailabilityDeps;
  reporter?: SandboxRuntimeReporter;
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

  options.reporter?.({
    type: "start",
    backend: sandbox.backend,
    image: sandbox.backend === "docker" ? sandbox.docker.image : undefined,
    reuseContainer: sandbox.backend === "docker" ? sandbox.docker.reuseContainer : undefined,
  });

  if (sandbox.backend === "srt") {
    options.reporter?.({ type: "check-availability", backend: "srt" });
    const availability = getSrtAvailability(options.settings.sandbox, options.deps);
    if (!availability.available) {
      if (sandbox.failIfUnavailable) {
        throw new SandboxUnavailableError(availability.reason ?? "srt sandbox is unavailable");
      }
      options.reporter?.({
        type: "unavailable",
        backend: "srt",
        reason: availability.reason ?? "srt sandbox is unavailable",
      });
      return inertRuntime(statusFromAvailability("unavailable", availability));
    }
    options.reporter?.({ type: "ready", backend: "srt" });
    return inertRuntime(statusFromAvailability("active", availability));
  }

  options.reporter?.({ type: "check-availability", backend: "docker" });
  const availability = getDockerAvailability(options.settings.sandbox, options.deps);
  if (!availability.available) {
    if (sandbox.failIfUnavailable) {
      throw new SandboxUnavailableError(availability.reason ?? "Docker sandbox is unavailable");
    }
    options.reporter?.({
      type: "unavailable",
      backend: "docker",
      reason: availability.reason ?? "Docker sandbox is unavailable",
    });
    return inertRuntime(statusFromAvailability("unavailable", availability));
  }

  const session = new DockerSandboxSession({
    settings: options.settings,
    sessionId: options.sessionId,
    cwd: options.cwd,
    deps: options.deps,
    reporter: options.reporter,
  });
  try {
    await session.start();
  } catch (error) {
    if (sandbox.failIfUnavailable) throw error;
    options.reporter?.({
      type: "unavailable",
      backend: "docker",
      reason: error instanceof Error ? error.message : String(error),
    });
    return inertRuntime(statusFromAvailability("unavailable", {
      ...availability,
      available: false,
      active: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
  }
  setActiveSandboxSession(session);
  options.reporter?.({ type: "ready", backend: "docker", containerName: session.containerName });

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
    reuseContainer: sandbox?.docker.reuseContainer,
  };
}

function dockerProxyStatus(extraEnv: Record<string, string>): "configured" | "not configured" {
  return extraEnv.HTTP_PROXY || extraEnv.HTTPS_PROXY || extraEnv.http_proxy || extraEnv.https_proxy
    ? "configured"
    : "not configured";
}
