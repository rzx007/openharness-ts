import { Command } from "commander";
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
    .option("--fail-open", "Continue without sandbox if the backend is unavailable")
    .action(async (options: SandboxOnOptions) => {
      const { loadSettings, saveSettings } = await import("@openharness/core");
      const settings = await loadSettings();
      const next = applySandboxOnConfig(settings, options);
      await saveSettings(next);
      console.log(formatSandboxStatus(next));
      console.log("\nRestart OpenHarness for this change to affect the runtime.");
    });

  cmd
    .command("off")
    .description("Disable sandbox mode")
    .action(async () => {
      const { loadSettings, saveSettings } = await import("@openharness/core");
      const settings = await loadSettings();
      const next = applySandboxOffConfig(settings);
      await saveSettings(next);
      console.log("Sandbox: disabled");
      console.log("\nRestart OpenHarness for this change to affect the runtime.");
    });

  cmd
    .command("status")
    .description("Show persisted sandbox configuration")
    .action(async () => {
      const { loadSettings } = await import("@openharness/core");
      const settings = await loadSettings();
      console.log(formatSandboxStatus(settings));
    });

  cmd
    .command("doctor")
    .description("Check sandbox backend availability")
    .action(async () => {
      const { loadSettings } = await import("@openharness/core");
      const { getSandboxAvailability } = await import("@openharness/sandbox");
      const settings = await loadSettings();
      console.log(formatSandboxStatus(settings));
      const availability = getSandboxAvailability(settings.sandbox);
      console.log(`Available: ${availability.available ? "yes" : "no"}`);
      if (availability.platform) console.log(`Platform: ${availability.platform}`);
      if (availability.command) console.log(`Command: ${availability.command}`);
      if (availability.degraded) console.log("Mode: degraded");
      if (availability.reason) console.log(`Note: ${availability.reason}`);
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
