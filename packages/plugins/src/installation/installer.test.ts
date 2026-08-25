import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLocalNativePlugin } from "./installer.js";
import { readInstalledPluginStore } from "./store.js";

const fixture = fileURLToPath(new URL("../../fixtures/native-v1/minimal-skill", import.meta.url));
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ohs-plugin-install-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("installLocalNativePlugin", () => {
  it("validates, copies, validates again, then updates installed state", async () => {
    const result = await installLocalNativePlugin({
      sourcePath: fixture, scope: "user", cwd: root, approvedPermissions: [],
      cacheDir: join(root, "cache"), storePath: join(root, "installed.json"),
    });
    expect(result.status).toBe("installed");
    const store = await readInstalledPluginStore(join(root, "installed.json"));
    expect(Object.values(store.plugins)[0]?.id).toBe("dev.openharness.minimal-skill");
  });
});
