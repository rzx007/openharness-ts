import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePluginBehaviorDigest, materializePluginCache } from "./cache.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ohs-plugin-cache-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("plugin cache", () => {
  it("computes a stable content digest and materializes a complete version directory", async () => {
    const source = join(root, "source");
    await mkdir(join(source, ".openharness-plugin"), { recursive: true });
    await writeFile(join(source, ".openharness-plugin", "plugin.json"), "{}");
    const digest = await computePluginBehaviorDigest(source);
    expect(await computePluginBehaviorDigest(source)).toBe(digest);
    const target = await materializePluginCache(source, join(root, "cache"), "dev.example.plugin", "1", digest);
    expect(target).toContain(digest);
  });
});
