import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
      await printSandboxStatus({ global: options.global, doctor: false });
    });

  cmd
    .command("doctor")
    .description("Check sandbox backend availability")
    .option("--global", "Check only global user config")
    .action(async (options: { global?: boolean }) => {
      await printSandboxStatus({ global: options.global, doctor: true });
    });

  cmd
    .command("clean")
    .description("Remove the reusable Docker sandbox container for this project")
    .action(async () => {
      await removeReusableContainer("Removed sandbox container");
    });

  cmd
    .command("rebuild")
    .description("Remove the reusable Docker sandbox container so it is recreated with current config")
    .action(async () => {
      await removeReusableContainer("Removed sandbox container for rebuild");
      console.log("Start OpenHarness again to create the container with the current sandbox config.");
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

async function removeReusableContainer(successPrefix: string): Promise<void> {
  const { loadSettings } = await import("@openharness/core");
  const { dockerReusableContainerName } = await import("@openharness/sandbox");
  const settings = await loadSettings(undefined, { includeProject: true });
  const prefix = settings.sandbox?.docker?.containerNamePrefix ?? "openharness-sandbox";
  const containerName = dockerReusableContainerName(process.cwd(), prefix);
  const result = await runDocker(["rm", "-f", containerName]);
  if (result.exitCode === 0) {
    console.log(`${successPrefix}: ${containerName}`);
  } else {
    console.error(result.stderr || `Failed to remove sandbox container: ${containerName}`);
    process.exit(1);
  }
}

async function printSandboxStatus(options: { global?: boolean; doctor: boolean }): Promise<void> {
  const {
    getConfigFilePath,
    getProjectSettingsFilePath,
    loadSettings,
  } = await import("@openharness/core");
  const {
    getSandboxAvailability,
    inspectDockerSandbox,
  } = await import("@openharness/sandbox");
  const includeProject = !options.global;
  const settings = await loadSettings(undefined, { includeProject });
  console.log(formatSandboxStatus(settings));
  console.log(`Config scope: ${options.global ? "global+env" : "project+global+env"}`);
  console.log(`Global config: ${existsSync(getConfigFilePath()) ? getConfigFilePath() : "not found"}`);
  if (includeProject) {
    const projectPath = getProjectSettingsFilePath();
    console.log(`Project config: ${existsSync(projectPath) ? projectPath : "not found"}`);
  }
  const sandboxEnv = Object.keys(process.env).filter((key) => key.startsWith("OPENHARNESS_SANDBOX_"));
  console.log(`Env overrides: ${sandboxEnv.length > 0 ? sandboxEnv.sort().join(", ") : "none"}`);

  if (!settings.sandbox?.enabled) return;

  const availability = getSandboxAvailability(settings.sandbox);
  if (options.doctor) {
    console.log(`Available: ${availability.available ? "yes" : "no"}`);
    if (availability.platform) console.log(`Platform: ${availability.platform}`);
    if (availability.command) console.log(`Command: ${availability.command}`);
    if (availability.degraded) console.log("Mode: degraded");
    if (availability.reason) console.log(`Note: ${availability.reason}`);
  }

  if ((settings.sandbox.backend ?? "srt") !== "docker") return;

  const diagnostics = await inspectDockerSandbox({
    config: settings.sandbox,
    cwd: process.cwd(),
    dockerCommand: availability.command,
  });
  console.log(`Container: ${diagnostics.containerName}`);
  console.log(`Container exists: ${diagnostics.containerExists ? "yes" : "no"}`);
  console.log(`Container running: ${diagnostics.containerRunning ? "yes" : "no"}`);
  console.log(`Image exists: ${diagnostics.imageExists ? "yes" : "no"} (${diagnostics.image})`);
  console.log(`Dockerfile: ${diagnostics.dockerfileFound ? diagnostics.dockerfile : `not found (${diagnostics.dockerfile})`}`);
  console.log(`Config hash: ${diagnostics.expectedConfigHash}`);
  if (diagnostics.containerExists) {
    console.log(`Container config hash: ${diagnostics.containerConfigHash || "missing"}`);
    console.log(`Container config matches: ${diagnostics.containerConfigMatches === true ? "yes" : "no"}`);
    if (diagnostics.containerConfigMatches === false) {
      console.log("Action: run 'ohs sandbox rebuild' to recreate the reusable container.");
    }
  }
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
