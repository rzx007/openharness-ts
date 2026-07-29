import type { SandboxConfig } from "@openharness/core";
import type { ResolvedSandboxConfig } from "./types.js";

export function normalizeSandboxConfig(config?: SandboxConfig): ResolvedSandboxConfig {
  const backend = config?.backend ?? normalizeRuntimeAlias(config?.runtime) ?? "srt";
  return {
    enabled: config?.enabled ?? false,
    backend,
    runtime: config?.runtime,
    failIfUnavailable: config?.failIfUnavailable ?? false,
    enabledPlatforms: config?.enabledPlatforms ?? [],
    filesystem: {
      allowRead: config?.filesystem?.allowRead ?? ["."],
      denyRead: config?.filesystem?.denyRead ?? [],
      allowWrite: config?.filesystem?.allowWrite ?? ["."],
      denyWrite: config?.filesystem?.denyWrite ?? [],
      extraAllowedRoots: config?.filesystem?.extraAllowedRoots ?? [],
    },
    network: {
      mode: config?.network?.mode ?? "none",
      allowedDomains: config?.network?.allowedDomains ?? [],
      deniedDomains: config?.network?.deniedDomains ?? [],
      strictDomainPolicy: config?.network?.strictDomainPolicy ?? false,
    },
    docker: {
      image: config?.docker?.image ?? "openharness-sandbox:latest",
      autoBuildImage: config?.docker?.autoBuildImage ?? true,
      cpuLimit: config?.docker?.cpuLimit ?? 0,
      memoryLimit: config?.docker?.memoryLimit ?? "",
      dns: config?.docker?.dns ?? [],
      extraMounts: config?.docker?.extraMounts ?? [],
      extraEnv: config?.docker?.extraEnv ?? {},
      containerNamePrefix: config?.docker?.containerNamePrefix ?? "openharness-sandbox",
      reuseContainer: config?.docker?.reuseContainer ?? false,
    },
    srt: {
      runtimeCommand: config?.srt?.runtimeCommand ?? "srt",
    },
  };
}

function normalizeRuntimeAlias(runtime?: string): "srt" | "docker" | undefined {
  if (runtime === "srt" || runtime === "docker") return runtime;
  return undefined;
}
