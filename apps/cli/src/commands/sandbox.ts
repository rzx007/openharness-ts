import { Command } from "commander";
import type { Settings } from "@openharness/core";

export function enableSandbox(settings: Settings, options: { failOpen?: boolean } = {}): Settings {
  return {
    ...settings,
    sandbox: { ...(settings.sandbox ?? { enabled: false }), enabled: true, failIfUnavailable: !options.failOpen },
  };
}

export function disableSandbox(settings: Settings): Settings {
  return { ...settings, sandbox: { ...(settings.sandbox ?? { enabled: false }), enabled: false } };
}

export function formatSandboxStatus(settings: Settings): string {
  const sandbox = settings.sandbox;
  if (!sandbox?.enabled) return "Sandbox: disabled";
  return ["Sandbox: enabled", "Runtime: SRT", `Fail if unavailable: ${sandbox.failIfUnavailable === false ? "false" : "true"}`].join("\n");
}

export function createSandboxCommand(): Command {
  const command = new Command("sandbox").description("Manage the local SRT sandbox");
  command.command("enable").option("--global").option("--fail-open").action(async (options) => {
    const { loadSettings, loadProjectSettings, saveProjectSettings, saveSettings } = await import("@openharness/core");
    const current = options.global ? await loadSettings() : { ...(await loadSettings()), ...(await loadProjectSettings(process.cwd())) };
    const next = enableSandbox(current, options);
    if (options.global) await saveSettings(next);
    else await saveProjectSettings({ sandbox: next.sandbox }, process.cwd());
    console.log(formatSandboxStatus(next));
  });
  command.command("disable").option("--global").action(async (options) => {
    const { loadSettings, loadProjectSettings, saveProjectSettings, saveSettings } = await import("@openharness/core");
    const current = options.global ? await loadSettings() : { ...(await loadSettings()), ...(await loadProjectSettings(process.cwd())) };
    const next = disableSandbox(current);
    if (options.global) await saveSettings(next);
    else await saveProjectSettings({ sandbox: next.sandbox }, process.cwd());
    console.log(formatSandboxStatus(next));
  });
  command.command("status").action(async () => {
    const { loadSettings } = await import("@openharness/core");
    console.log(formatSandboxStatus(await loadSettings(undefined, { includeProject: true, projectRoot: process.cwd() })));
  });
  command.command("check").action(async () => {
    const { loadSettings } = await import("@openharness/core");
    const { getSandboxAvailability } = await import("@openharness/sandbox");
    console.log(JSON.stringify(getSandboxAvailability((await loadSettings(undefined, { includeProject: true, projectRoot: process.cwd() })).sandbox), null, 2));
  });
  return command;
}
