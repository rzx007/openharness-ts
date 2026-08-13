import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings, saveMcpServerConfig } from "./settings.js";

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
    const projectConfigDir = join(projectRoot, ".openharness");
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

  it("patches MCP auth into project settings without dumping merged runtime secrets", async () => {
    const projectRoot = join(configDir, "project");
    const projectConfigDir = join(projectRoot, ".openharness");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      model: "global-model",
      apiKey: "should-stay-untouched",
      mcpServers: {
        globalOnly: { url: "https://global.example" },
      },
    }));
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
      mcpServers: {
        remote: { url: "https://mcp.example" },
      },
    }));

    const scope = await saveMcpServerConfig("remote", {
      url: "https://mcp.example",
      headers: { Authorization: "Bearer tok" },
    }, { projectRoot });

    expect(scope).toBe("project");
    expect(JSON.parse(readFileSync(join(projectConfigDir, "settings.json"), "utf-8"))).toEqual({
      mcpServers: {
        remote: {
          url: "https://mcp.example",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });
    expect(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf-8"))).toEqual({
      model: "global-model",
      apiKey: "should-stay-untouched",
      mcpServers: {
        globalOnly: { url: "https://global.example" },
      },
    });
  });
});
