import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { SandboxConfig } from "@openharness/core";
import { normalizeSandboxConfig } from "./config.js";
import {
  detectSandboxPlatform,
  supportsDockerSandbox,
  supportsSandboxRuntime,
} from "./platform.js";
import type { SandboxAvailability, SandboxPlatform } from "./types.js";

export interface AvailabilityDeps {
  platform?: SandboxPlatform;
  which?: (command: string) => string | undefined;
  dockerInfo?: (dockerCommand: string) => boolean;
}

export function getSandboxAvailability(
  config?: SandboxConfig,
  deps: AvailabilityDeps = {},
): SandboxAvailability {
  const resolved = normalizeSandboxConfig(config);
  if (!resolved.enabled) {
    return {
      enabled: false,
      available: false,
      active: false,
      backend: resolved.backend,
      reason: "sandbox is disabled",
    };
  }

  if (resolved.backend === "docker") {
    return getDockerAvailability(config, deps);
  }
  return getSrtAvailability(config, deps);
}

export function getSrtAvailability(
  config?: SandboxConfig,
  deps: AvailabilityDeps = {},
): SandboxAvailability {
  const resolved = normalizeSandboxConfig(config);
  const platform = deps.platform ?? detectSandboxPlatform();

  if (!resolved.enabled || resolved.backend !== "srt") {
    return {
      enabled: false,
      available: false,
      active: false,
      backend: "srt",
      platform,
      reason: "srt sandbox is not enabled",
    };
  }

  if (!supportsSandboxRuntime(platform)) {
    const reason = platform === "windows"
      ? "sandbox runtime is not supported on native Windows; use WSL"
      : `sandbox runtime is not supported on platform ${platform}`;
    return unavailable("srt", platform, reason);
  }

  if (resolved.enabledPlatforms.length > 0 && !resolved.enabledPlatforms.includes(platform as never)) {
    return unavailable("srt", platform, `sandbox is disabled for platform ${platform} by configuration`);
  }

  const which = deps.which ?? findExecutable;
  const srt = which(resolved.srt.runtimeCommand);
  if (!srt) {
    return unavailable(
      "srt",
      platform,
      "sandbox runtime CLI not found; install @anthropic-ai/sandbox-runtime",
    );
  }

  if ((platform === "linux" || platform === "wsl") && !which("bwrap")) {
    return unavailable("srt", platform, "bubblewrap (`bwrap`) is required for sandbox runtime");
  }

  if (platform === "macos" && !which("sandbox-exec")) {
    return unavailable("srt", platform, "`sandbox-exec` is required for sandbox runtime on macOS");
  }

  return {
    enabled: true,
    available: true,
    active: true,
    backend: "srt",
    platform,
    command: srt,
  };
}

export function getDockerAvailability(
  config?: SandboxConfig,
  deps: AvailabilityDeps = {},
): SandboxAvailability {
  const resolved = normalizeSandboxConfig(config);
  const platform = deps.platform ?? detectSandboxPlatform();

  if (!resolved.enabled || resolved.backend !== "docker") {
    return {
      enabled: false,
      available: false,
      active: false,
      backend: "docker",
      platform,
      reason: "Docker sandbox is not enabled",
    };
  }

  if (!supportsDockerSandbox(platform)) {
    return unavailable("docker", platform, `Docker sandbox is not supported on platform ${platform}`);
  }

  if (resolved.network.mode === "host" && platform === "macos") {
    return unavailable("docker", platform, "Docker host network mode is not supported on macOS in MVP");
  }

  if (resolved.network.mode === "proxy" && !hasProxyEnv(resolved.docker.extraEnv)) {
    return unavailable("docker", platform, "Docker proxy network mode requires HTTP_PROXY or HTTPS_PROXY");
  }

  const hasDomainPolicy = resolved.network.allowedDomains.length > 0 ||
    resolved.network.deniedDomains.length > 0;
  if (
    hasDomainPolicy &&
    resolved.network.strictDomainPolicy &&
    (resolved.network.mode === "bridge" || resolved.network.mode === "host")
  ) {
    return unavailable(
      "docker",
      platform,
      `Docker ${resolved.network.mode} network mode cannot enforce strict domain policy`,
    );
  }

  const which = deps.which ?? findExecutable;
  const docker = which("docker");
  if (!docker) {
    return unavailable("docker", platform, "Docker CLI not found");
  }

  if (deps.dockerInfo && !deps.dockerInfo(docker)) {
    return unavailable("docker", platform, "Docker daemon is not running", docker);
  }

  return {
    enabled: true,
    available: true,
    active: true,
    backend: "docker",
    platform,
    command: docker,
    degraded: hasDomainPolicy && dockerNetworkDoesNotEnforceDomains(resolved.network.mode),
    reason: hasDomainPolicy && dockerNetworkDoesNotEnforceDomains(resolved.network.mode)
      ? `Docker ${resolved.network.mode} network mode does not enforce domain policy`
      : undefined,
  };
}

function dockerNetworkDoesNotEnforceDomains(mode: string): boolean {
  return mode === "bridge" || mode === "host" || mode === "proxy";
}

function hasProxyEnv(extraEnv: Record<string, string>): boolean {
  return Boolean(
    extraEnv.HTTP_PROXY ||
      extraEnv.HTTPS_PROXY ||
      extraEnv.http_proxy ||
      extraEnv.https_proxy
  );
}

function unavailable(
  backend: "srt" | "docker",
  platform: SandboxPlatform,
  reason: string,
  command?: string,
): SandboxAvailability {
  return {
    enabled: true,
    available: false,
    active: false,
    backend,
    platform,
    reason,
    command,
  };
}

function findExecutable(command: string): string | undefined {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return undefined;
  const extensions = process.platform === "win32"
    ? ["", ".exe", ".cmd", ".bat"]
    : [""];
  for (const dir of pathEnv.split(delimiter)) {
    for (const ext of extensions) {
      const candidate = join(dir, command.endsWith(ext) ? command : `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
