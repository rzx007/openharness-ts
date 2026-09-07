import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings, saveSettings } from "./settings.js";

describe("daemon settings", () => {
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "openharness-settings-"));
    previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
    else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("keeps automatic daemon startup off by default", async () => {
    expect((await loadSettings()).daemon).toEqual({ autoStart: false });
    expect((await loadSettings()).plugins).toEqual({ enabled: true });
    expect((await loadSettings()).workStyle).toBe("practical");
  });

  it("loads an explicit efficient work style", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      workStyle: "efficient",
    }));

    expect((await loadSettings()).workStyle).toBe("efficient");
  });

  it("merges the plugin master switch with project and CLI precedence", async () => {
    const projectRoot = join(configDir, "plugin-project");
    const projectConfigDir = join(projectRoot, ".openharness-ts");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      plugins: { enabled: true },
    }));
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
      plugins: { enabled: false },
    }));

    expect((await loadSettings(undefined, { includeProject: true, projectRoot })).plugins).toEqual({ enabled: false });
    expect((await loadSettings(
      { plugins: { enabled: true } },
      { includeProject: true, projectRoot },
    )).plugins).toEqual({ enabled: true });
  });

  it("merges daemon.autoStart from the user settings file", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      daemon: { autoStart: true },
    }));

    const settings = await loadSettings();

    expect(settings.daemon).toEqual({ autoStart: true });
    expect(settings.model).toBeTruthy();
  });

  it("does not let project settings change machine-wide automatic startup", async () => {
    const projectRoot = join(configDir, "project");
    const projectConfigDir = join(projectRoot, ".openharness-ts");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      daemon: { autoStart: false },
    }));
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
      daemon: { autoStart: true },
    }));

    const settings = await loadSettings(undefined, { includeProject: true, projectRoot });

    expect(settings.daemon).toEqual({ autoStart: false });
  });

  it("loads the current schema without a version marker", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      sandbox: { enabled: false },
      terminal: { localShell: "powershell.exe" },
    }));

    expect(await loadSettings()).toMatchObject({
      sandbox: { enabled: false },
      terminal: { localShell: "powershell.exe", dockerShell: "/bin/sh" },
    });
  });

  it("rejects version markers and deprecated sandbox fields", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      _formatVersion: 1,
      sandbox: { enabled: false },
    }));
    await expect(loadSettings()).rejects.toMatchObject({
      code: "invalid_settings_field",
    });

    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      sandbox: { enabled: true, runtime: "docker" },
    }));
    await expect(loadSettings()).rejects.toMatchObject({
      code: "invalid_settings_field",
    });
  });

  it("saves settings without adding a version marker", async () => {
    await saveSettings(await loadSettings());

    const saved = JSON.parse(
      readFileSync(join(configDir, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(saved).not.toHaveProperty("_formatVersion");
  });

  it("deep-merges local and Docker terminal shell preferences", async () => {
    const projectRoot = join(configDir, "terminal-project");
    const projectConfigDir = join(projectRoot, ".openharness-ts");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      terminal: { localShell: "powershell.exe" },
    }));
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
      terminal: { dockerShell: "/bin/bash" },
    }));

    expect(
      (await loadSettings(undefined, { includeProject: true, projectRoot }))
        .terminal,
    ).toEqual({
      localShell: "powershell.exe",
      dockerShell: "/bin/bash",
    });
  });
});
