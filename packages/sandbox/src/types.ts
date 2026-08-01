import type { ChildProcess, StdioOptions } from "node:child_process";
import type { SandboxConfig, Settings } from "@openharness/core";

export type SandboxBackend = "srt" | "docker";
export type SandboxPlatform = "linux" | "wsl" | "macos" | "windows" | "unknown";
export type SandboxNetworkMode = "none" | "bridge" | "host" | "proxy";
export type SandboxOperation = "read" | "write";

export interface ResolvedSandboxConfig {
  enabled: boolean;
  backend: SandboxBackend;
  runtime?: string;
  failIfUnavailable: boolean;
  enabledPlatforms: Array<"linux" | "wsl" | "macos">;
  filesystem: {
    allowRead: string[];
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
    extraAllowedRoots: string[];
  };
  network: {
    mode: SandboxNetworkMode;
    allowedDomains: string[];
    deniedDomains: string[];
    strictDomainPolicy: boolean;
  };
  docker: {
    image: string;
    autoBuildImage: boolean;
    cpuLimit: number;
    memoryLimit: string;
    dns: string[];
    extraMounts: string[];
    extraEnv: Record<string, string>;
    containerNamePrefix: string;
    reuseContainer: boolean;
  };
  srt: {
    runtimeCommand: string;
  };
}

export interface SandboxAvailability {
  enabled: boolean;
  available: boolean;
  active: boolean;
  backend?: SandboxBackend;
  platform?: SandboxPlatform;
  reason?: string;
  degraded?: boolean;
  command?: string;
}

export type SandboxRuntimeState = "off" | "active" | "degraded" | "unavailable";

export type SandboxRuntimeEvent =
  | { type: "start"; backend: SandboxBackend; image?: string; reuseContainer?: boolean }
  | { type: "check-availability"; backend: SandboxBackend }
  | { type: "check-image"; image: string }
  | { type: "build-image"; image: string; dockerfile: string }
  | { type: "start-container"; containerName: string; reused: boolean }
  | { type: "ready"; backend: SandboxBackend; containerName?: string }
  | { type: "unavailable"; backend: SandboxBackend; reason: string };

export type SandboxRuntimeReporter = (event: SandboxRuntimeEvent) => void;

export interface SandboxRuntimeStatus {
  state: SandboxRuntimeState;
  enabled: boolean;
  active: boolean;
  backend?: SandboxBackend;
  platform?: SandboxPlatform;
  reason?: string;
  degraded?: boolean;
  containerName?: string;
  containerCwd?: string;
  networkMode?: SandboxNetworkMode;
  dns?: string[];
  proxy?: "configured" | "not configured";
  reuseContainer?: boolean;
}

export interface ShellSpawnOptions {
  cwd: string;
  settings?: Settings;
  stdio?: StdioOptions;
  env?: Record<string, string>;
}

export interface SandboxSession {
  readonly backend: SandboxBackend;
  readonly cwd: string;
  readonly active: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  stopSync?(): void;
  wrapCommand?(argv: string[]): Promise<{ argv: string[]; cleanup?: () => Promise<void> }>;
  execCommand?(argv: string[], options: ShellSpawnOptions): Promise<ChildProcess>;
}

export interface ValidateSandboxPathOptions {
  sandboxRoot: string;
  operation: SandboxOperation;
  config?: SandboxConfig;
  extraAllowedRoots?: string[];
}

export interface SandboxPathValidationResult {
  allowed: boolean;
  resolvedPath: string;
  reason?: string;
}
