import { Command } from "commander";
import { spawn } from "node:child_process";
import type { Settings } from "@openharness/core";

type SandboxBackend = "docker" | "srt";
type SandboxNetworkMode = "none" | "bridge" | "host" | "proxy";

export interface SandboxOnOptions {
  backend?: string;
  net?: string;
  image?: string;
  dns?: string;
  proxy?: string;
  build?: boolean;
  failOpen?: boolean;
  global?: boolean;
  reuse?: boolean;
}

export function applySandboxOnConfig(
  settings: Settings,
  options: SandboxOnOptions,
): Settings {
  const backend = parseBackend(options.backend ?? settings.sandbox?.backend ?? "docker");
  const networkMode = parseNetworkMode(options.net ?? settings.sandbox?.network?.mode ?? "bridge");
  const docker = {
    ...(settings.sandbox?.docker ?? {}),
    image: options.image ?? settings.sandbox?.docker?.image ?? "openharness-sandbox:latest",
    autoBuildImage: options.build ?? true,
    reuseContainer: options.reuse ?? true,
  };

  if (options.dns !== undefined) {
    docker.dns = parseList(options.dns);
  }

  const extraEnv = { ...(docker.extraEnv ?? {}) };
  if (options.proxy !== undefined) {
    extraEnv.HTTP_PROXY = options.proxy;
    extraEnv.HTTPS_PROXY = options.proxy;
    extraEnv.http_proxy = options.proxy;
    extraEnv.https_proxy = options.proxy;
  }
  if (Object.keys(extraEnv).length > 0) docker.extraEnv = extraEnv;

  return {
    ...settings,
    sandbox: {
      ...(settings.sandbox ?? { enabled: false }),
      enabled: true,
      backend,
      failIfUnavailable: options.failOpen ? false : true,
      network: {
        ...(settings.sandbox?.network ?? {}),
        mode: networkMode,
      },
      docker,
    },
  };
}

export function applySandboxOffConfig(settings: Settings): Settings {
  return {
    ...settings,
    sandbox: {
      ...(settings.sandbox ?? { enabled: false }),
      enabled: false,
    },
  };
}

export function formatSandboxStatus(settings: Settings): string {
  const sandbox = settings.sandbox;
  if (!sandbox?.enabled) return "Sandbox: disabled";

  const lines = [
    "Sandbox: enabled",
    `Backend: ${sandbox.backend ?? "srt"}`,
    `Network: ${sandbox.network?.mode ?? "none"}`,
    `Fail if unavailable: ${sandbox.failIfUnavailable === false ? "false" : "true"}`,
  ];

  if ((sandbox.backend ?? "srt") === "docker") {
    lines.push(`Image: ${sandbox.docker?.image ?? "openharness-sandbox:latest"}`);
    lines.push(`Auto build: ${sandbox.docker?.autoBuildImage === false ? "false" : "true"}`);
    lines.push(`Reuse container: ${sandbox.docker?.reuseContainer === false ? "false" : "true"}`);
    if (sandbox.docker?.dns?.length) lines.push(`DNS: ${sandbox.docker.dns.join(", ")}`);
    lines.push(`Proxy: ${hasProxyEnv(sandbox.docker?.extraEnv) ? "configured" : "not configured"}`);
  }

  return lines.join("\n");
}

export function createSandboxCommand(): Command {
  const cmd = new Command("sandbox").description("Manage sandbox mode");

  cmd
    .command("on")
    .description("Enable sandbox mode")
    .option("--backend <backend>", "Sandbox backend (docker | srt)", "docker")
    .option("--net <mode>", "Network mode (none | bridge | host | proxy)", "bridge")
    .option("--image <image>", "Docker image to use")
    .option("--dns <servers>", "Comma-separated Docker DNS servers")
    .option("--proxy <url>", "Proxy URL for Docker proxy mode")
    .option("--no-build", "Do not auto-build the default Docker image")
    .option("--no-reuse", "Create a temporary container for each OpenHarness session")
    .option("--global", "Write sandbox settings to the global user config")
    .option("--fail-open", "Continue without sandbox if the backend is unavailable")
    .action(async (options: SandboxOnOptions) => {
      const {
        loadSettings,
        loadProjectSettings,
        saveProjectSettings,
        saveSettings,
      } = await import("@openharness/core");
      const settings = await loadSettings(undefined, { includeProject: !options.global });
      const next = applySandboxOnConfig(settings, options);
      if (options.global) {
        await saveSettings(next);
      } else {
        const projectSettings = await loadProjectSettings() ?? {};
        await saveProjectSettings({ ...projectSettings, sandbox: next.sandbox });
      }
      console.log(formatSandboxStatus(next));
      console.log(`\nSaved to ${options.global ? "global" : "project"} config. Restart OpenHarness for this change to affect the runtime.`);
    });

  cmd
    .command("off")
    .description("Disable sandbox mode")
    .option("--global", "Write to the global user config")
    .action(async (options: { global?: boolean }) => {
      const {
        loadSettings,
        loadProjectSettings,
        saveProjectSettings,
        saveSettings,
      } = await import("@openharness/core");
      const settings = await loadSettings(undefined, { includeProject: !options.global });
      const next = applySandboxOffConfig(settings);
      if (options.global) {
        await saveSettings(next);
      } else {
        const projectSettings = await loadProjectSettings() ?? {};
        await saveProjectSettings({ ...projectSettings, sandbox: next.sandbox });
      }
      console.log("Sandbox: disabled");
      console.log(`\nSaved to ${options.global ? "global" : "project"} config. Restart OpenHarness for this change to affect the runtime.`);
    });

  cmd
    .command("status")
    .description("Show persisted sandbox configuration")
    .option("--global", "Show only global user config")
    .action(async (options: { global?: boolean }) => {
      const { loadSettings } = await import("@openharness/core");
      const settings = await loadSettings(undefined, { includeProject: !options.global });
      console.log(formatSandboxStatus(settings));
    });

  cmd
    .command("doctor")
    .description("Check sandbox backend availability")
    .option("--global", "Check only global user config")
    .action(async (options: { global?: boolean }) => {
      const { loadSettings } = await import("@openharness/core");
      const { getSandboxAvailability } = await import("@openharness/sandbox");
      const settings = await loadSettings(undefined, { includeProject: !options.global });
      console.log(formatSandboxStatus(settings));
      const availability = getSandboxAvailability(settings.sandbox);
      console.log(`Available: ${availability.available ? "yes" : "no"}`);
      if (availability.platform) console.log(`Platform: ${availability.platform}`);
      if (availability.command) console.log(`Command: ${availability.command}`);
      if (availability.degraded) console.log("Mode: degraded");
      if (availability.reason) console.log(`Note: ${availability.reason}`);
    });

  cmd
    .command("clean")
    .description("Remove the reusable Docker sandbox container for this project")
    .action(async () => {
      const { loadSettings } = await import("@openharness/core");
      const { dockerReusableContainerName } = await import("@openharness/sandbox");
      const settings = await loadSettings(undefined, { includeProject: true });
      const prefix = settings.sandbox?.docker?.containerNamePrefix ?? "openharness-sandbox";
      const containerName = dockerReusableContainerName(process.cwd(), prefix);
      const result = await runDocker(["rm", "-f", containerName]);
      if (result.exitCode === 0) {
        console.log(`Removed sandbox container: ${containerName}`);
      } else {
        console.error(result.stderr || `Failed to remove sandbox container: ${containerName}`);
        process.exit(1);
      }
    });

  return cmd;
}

function parseBackend(value: string): SandboxBackend {
  if (value === "docker" || value === "srt") return value;
  throw new Error(`Unsupported sandbox backend: ${value}`);
}

function parseNetworkMode(value: string): SandboxNetworkMode {
  if (value === "none" || value === "bridge" || value === "host" || value === "proxy") return value;
  throw new Error(`Unsupported sandbox network mode: ${value}`);
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasProxyEnv(extraEnv?: Record<string, string>): boolean {
  if (!extraEnv) return false;
  return Boolean(extraEnv.HTTP_PROXY || extraEnv.HTTPS_PROXY || extraEnv.http_proxy || extraEnv.https_proxy);
}

function runDocker(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ exitCode: 1, stderr: error.message }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stderr: stderr.trim() }));
  });
}
