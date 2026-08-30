import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePluginBehaviorDigest, materializePluginCache } from "./cache.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ohs-plugin-cache-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("plugin cache", () => {
  it("computes a stable content digest and materializes a complete current directory", async () => {
    const source = join(root, "source");
    await mkdir(join(source, ".openharness-plugin"), { recursive: true });
    await writeFile(join(source, ".openharness-plugin", "plugin.json"), "{}");
    const digest = await computePluginBehaviorDigest(source);
    expect(await computePluginBehaviorDigest(source)).toBe(digest);
    const target = await materializePluginCache(source, join(root, "cache"), "dev.example.plugin", digest);
    expect(target).toBe(join(root, "cache", "dev.example.plugin", "current"));
    expect(await readdir(join(root, "cache", "dev.example.plugin"))).toEqual(["current"]);
  });

  it("replaces current cache contents on reinstall without keeping version directories", async () => {
    const source = join(root, "source");
    await mkdir(join(source, ".openharness-plugin"), { recursive: true });
    await writeFile(join(source, ".openharness-plugin", "plugin.json"), "{}");
    await writeFile(join(source, "payload.txt"), "first");

    const cacheRoot = join(root, "cache");
    const pluginCacheRoot = join(cacheRoot, "dev.example.plugin");
    await mkdir(join(pluginCacheRoot, `1.0.0-${"a".repeat(64)}`), { recursive: true });
    const firstDigest = await computePluginBehaviorDigest(source);
    const firstTarget = await materializePluginCache(source, cacheRoot, "dev.example.plugin", firstDigest);
    expect(await readFile(join(firstTarget, "payload.txt"), "utf8")).toBe("first");
    expect(await readdir(pluginCacheRoot)).toEqual(["current"]);

    await writeFile(join(source, "payload.txt"), "second");
    const secondDigest = await computePluginBehaviorDigest(source);
    const secondTarget = await materializePluginCache(source, cacheRoot, "dev.example.plugin", secondDigest);

    expect(secondTarget).toBe(firstTarget);
    expect(await readFile(join(secondTarget, "payload.txt"), "utf8")).toBe("second");
    expect(await readdir(join(cacheRoot, "dev.example.plugin"))).toEqual(["current"]);
  });

  it("keeps the previous current cache when candidate validation fails", async () => {
    const source = join(root, "source");
    await mkdir(join(source, ".openharness-plugin"), { recursive: true });
    await writeFile(join(source, ".openharness-plugin", "plugin.json"), "{}");
    await writeFile(join(source, "payload.txt"), "known-good");

    const cacheRoot = join(root, "cache");
    const firstDigest = await computePluginBehaviorDigest(source);
    const current = await materializePluginCache(source, cacheRoot, "dev.example.plugin", firstDigest);

    await writeFile(join(source, "payload.txt"), "invalid-candidate");
    const secondDigest = await computePluginBehaviorDigest(source);
    await expect(materializePluginCache(
      source,
      cacheRoot,
      "dev.example.plugin",
      secondDigest,
      async () => { throw new Error("candidate validation failed"); },
    )).rejects.toThrow("candidate validation failed");

    expect(await readFile(join(current, "payload.txt"), "utf8")).toBe("known-good");
    expect(await readdir(join(cacheRoot, "dev.example.plugin"))).toEqual(["current"]);
  });
});
