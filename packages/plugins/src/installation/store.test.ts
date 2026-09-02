import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverInstalledNativePlugins, readInstalledPluginStore, updateInstalledPluginStore } from "./store.js";

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ohs-plugin-store-")); file = join(dir, "installed.json"); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("installed plugin store", () => {
  it("starts empty and atomically increments revision", async () => {
    expect(await readInstalledPluginStore(file)).toEqual({ schemaVersion: 1, revision: 0, plugins: {} });
    await updateInstalledPluginStore(file, (store) => {
      store.plugins["user:dev.example.plugin"] = {
        id: "dev.example.plugin", scope: "user", enabled: true, currentVersion: "1",
        cachePath: "cache", origin: "native", requestedPermissions: [], approvedPermissions: [],
        installedAt: "now", updatedAt: "now",
      };
    });
    expect((await readInstalledPluginStore(file)).revision).toBe(1);
    expect(JSON.parse(await readFile(file, "utf8")).revision).toBe(1);
  });

  it("rejects unsupported store versions", async () => {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, JSON.stringify({ schemaVersion: 2 })));
    await expect(readInstalledPluginStore(file)).rejects.toThrow("Unsupported installed plugin store");
  });

  it("discovers only global records and warns about legacy project-local installations", async () => {
    await updateInstalledPluginStore(file, (store) => {
      const common = {
        enabled: true,
        currentVersion: "1",
        cachePath: "cache",
        origin: "native" as const,
        requestedPermissions: [],
        approvedPermissions: [],
        installedAt: "now",
        updatedAt: "now",
      };
      store.plugins["user::dev.example.user"] = { id: "dev.example.user", scope: "user", ...common };
      store.plugins["project:C:/workspace:dev.example.project"] = {
        id: "dev.example.project", scope: "project", projectDir: "C:/workspace", ...common,
      };
      store.plugins["local:C:/workspace:dev.example.local"] = {
        id: "dev.example.local", scope: "local", projectDir: "C:/workspace", ...common, enabled: false,
      };
    });
    const warnings: string[] = [];

    const records = await discoverInstalledNativePlugins({
      cwd: "C:/workspace",
      storePath: file,
      onWarning: (warning: string) => warnings.push(warning),
    } as Parameters<typeof discoverInstalledNativePlugins>[0] & { onWarning(warning: string): void });

    expect(records.map((record) => record.id)).toEqual(["dev.example.user"]);
    expect(warnings).toEqual([
      "dev.example.project: ignored legacy project-scoped installation; reinstall it for the user",
      "dev.example.local: ignored legacy local-scoped installation; reinstall it for the user",
    ]);
  });
});
