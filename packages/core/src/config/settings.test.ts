import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings, saveProjectSettings, saveSettings } from "./settings.js";

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
      _formatVersion: 1,
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
      _formatVersion: 1,
      daemon: { autoStart: false },
    }));
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
      _formatVersion: 1,
      daemon: { autoStart: true },
    }));

    const settings = await loadSettings(undefined, { includeProject: true, projectRoot });

    expect(settings.daemon).toEqual({ autoStart: false });
  });

  it("does not persist in-memory apiKey (e.g. from env) into settings.json", async () => {
    const previousAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-env-should-not-hit-disk";
    try {
      const settings = await loadSettings();
      expect(settings.apiKey).toBe("sk-env-should-not-hit-disk");

      await saveSettings({
        ...settings,
        provider: "openai",
        customProviders: [
          {
            id: "gateway",
            displayName: "Gateway",
            baseUrl: "https://gateway.example/v1",
            apiFormat: "openai",
            models: [{ id: "m", displayName: "M" }],
          },
        ],
      });

      const raw = JSON.parse(
        readFileSync(join(configDir, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(raw.apiKey).toBeUndefined();
      expect(raw.provider).toBe("openai");
      expect(raw.customProviders).toEqual([
        expect.objectContaining({ id: "gateway" }),
      ]);
      // 调用方持有的内存对象不应被 saveSettings 改写
      expect(settings.apiKey).toBe("sk-env-should-not-hit-disk");
    } finally {
      if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropic;
    }
  });

  it("does not persist apiKey into project settings.json", async () => {
    const projectRoot = join(configDir, "project");
    await saveProjectSettings(
      {
        model: "local-model",
        apiKey: "sk-project-leak",
      } as Parameters<typeof saveProjectSettings>[0],
      projectRoot,
    );

    const raw = JSON.parse(
      readFileSync(join(projectRoot, ".openharness", "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(raw.apiKey).toBeUndefined();
    expect(raw.model).toBe("local-model");
  });
});
