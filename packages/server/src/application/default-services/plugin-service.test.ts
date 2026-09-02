import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getInstalledPluginStorePath } from "@openharness/core";
import { readInstalledPluginStore, updateInstalledPluginStore } from "@openharness/plugins";
import { createDefaultPluginService } from "./plugin-service.js";

let root: string;
let previousConfigDir: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ohs-plugin-service-"));
  previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
  process.env.OPENHARNESS_CONFIG_DIR = join(root, "config");
});

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
  else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
  await rm(root, { recursive: true, force: true });
});

async function writeLegacyProjectRecord(): Promise<void> {
  await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
    store.plugins["project:C:/workspace:dev.example.legacy"] = {
      id: "dev.example.legacy",
      scope: "project",
      projectDir: "C:/workspace",
      enabled: true,
      currentVersion: "1.0.0",
      cachePath: join(root, "missing-cache"),
      origin: "native",
      requestedPermissions: [],
      approvedPermissions: [],
      installedAt: "now",
      updatedAt: "now",
    };
  });
}

function service() {
  return createDefaultPluginService({ current: {
    model: "test",
    apiFormat: "anthropic",
    maxTurns: 1,
    permission: { mode: "default" },
  } });
}

describe("default plugin service user scope", () => {
  it("hides legacy project records and reports how to migrate them", async () => {
    await writeLegacyProjectRecord();

    await expect(service().list({ cwd: "C:/workspace" })).resolves.toEqual({
      plugins: [],
      warnings: ["dev.example.legacy: ignored legacy project-scoped installation; reinstall it for the user"],
    });
  });

  it.each(["setEnabled", "uninstall"] as const)("does not let %s mutate a legacy project record", async (operation) => {
    await writeLegacyProjectRecord();
    const plugins = service();

    const result = operation === "setEnabled"
      ? plugins.setEnabled({ id: "dev.example.legacy", cwd: "C:/workspace", enabled: false })
      : plugins.uninstall!({ id: "dev.example.legacy", cwd: "C:/workspace" });
    await expect(result).rejects.toThrow("Plugin not found for user: dev.example.legacy");
    expect(Object.values((await readInstalledPluginStore(getInstalledPluginStorePath())).plugins)[0]?.enabled).toBe(true);
  });

  it("marks an unverifiable copied user installation invalid without loading its contributions", async () => {
    const pluginDir = join(root, "cache", "dev.example.unverifiable");
    await mkdir(join(pluginDir, ".openharness-plugin"), { recursive: true });
    await mkdir(join(pluginDir, "skills", "unverifiable"), { recursive: true });
    await writeFile(join(pluginDir, ".openharness-plugin", "plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "dev.example.unverifiable",
      name: "unverifiable",
      version: "1.0.0",
      components: { skills: ["./skills"] },
    }));
    await writeFile(join(pluginDir, "skills", "unverifiable", "SKILL.md"), "---\nname: unverifiable\ndescription: fixture\n---\nDo not load.\n");
    await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
      store.plugins["user::dev.example.unverifiable"] = {
        id: "dev.example.unverifiable",
        scope: "user",
        enabled: true,
        currentVersion: "1.0.0",
        cachePath: pluginDir,
        origin: "native",
        requestedPermissions: [],
        approvedPermissions: [],
        installedAt: "now",
        updatedAt: "now",
      };
    });

    const listed = await service().list({ cwd: "C:/workspace" });

    expect(listed.plugins).toHaveLength(1);
    expect(listed.plugins[0]).toMatchObject({
      installation: "invalid",
      inventory: {},
      diagnostics: [{ code: "plugin_content_digest_missing" }],
    });
  });
});
