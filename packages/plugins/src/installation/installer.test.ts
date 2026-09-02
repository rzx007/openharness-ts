import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
    const record = Object.values(store.plugins)[0];
    expect(record?.id).toBe("dev.openharness.minimal-skill");
    expect(record?.cachePath).toBe(join(root, "cache", "dev.openharness.minimal-skill", `1.0.0-${record?.behaviorDigest}`));
    expect((record as { behaviorDigest?: string } | undefined)?.behaviorDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readdir(join(root, "cache", "dev.openharness.minimal-skill"))).toEqual([`1.0.0-${record?.behaviorDigest}`]);
  });

  it.each(["project", "local"] as const)("rejects the legacy %s installation scope", async (scope) => {
    const result = await installLocalNativePlugin({
      sourcePath: fixture,
      scope,
      cwd: root,
      approvedPermissions: [],
      cacheDir: join(root, "cache"),
      storePath: join(root, "installed.json"),
    } as unknown as Parameters<typeof installLocalNativePlugin>[0]);

    expect(result).toEqual({
      status: "blocked",
      diagnostics: [{
        severity: "error",
        phase: "install",
        code: "plugin_scope_not_supported",
        message: `Native Plugins can only be installed for the user; received scope '${scope}'`,
      }],
    });
    expect((await readInstalledPluginStore(join(root, "installed.json"))).plugins).toEqual({});
  });

  it("records converted origin from Native manifest metadata without conversion side files", async () => {
    const source = join(root, "converted-native");
    await mkdir(join(source, ".openharness-plugin"), { recursive: true });
    await mkdir(join(source, "skills", "metadata-only"), { recursive: true });
    await writeFile(join(source, "skills", "metadata-only", "SKILL.md"), [
      "---",
      "name: metadata-only",
      "description: Metadata-only converted plugin fixture",
      "---",
      "Use the fixture.",
    ].join("\n"));
    await writeFile(join(source, ".openharness-plugin", "plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "converted.claude.metadata-only",
      name: "metadata-only",
      version: "1.0.0",
      metadata: {
        origin: "converted",
        sourceFormat: "claude-code",
        converterId: "claude-code",
        converterVersion: "1.0.0",
      },
      components: { skills: ["./skills"] },
    }));

    const result = await installLocalNativePlugin({
      sourcePath: source,
      scope: "user",
      cwd: root,
      approvedPermissions: [],
      cacheDir: join(root, "cache"),
      storePath: join(root, "installed.json"),
    });

    expect(result.status).toBe("installed");
    if (result.status !== "installed") return;
    expect(result.record.origin).toBe("converted");
    expect(result.record.sourceFormat).toBe("claude-code");
  });
});
