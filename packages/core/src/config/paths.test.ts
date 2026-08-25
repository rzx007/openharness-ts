import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  getInstalledPluginStorePath,
  getPluginCacheDir,
  getPluginDataDir,
  getPluginSourcesDir,
  getProjectMemoryDir,
} from "./paths";

describe("getProjectMemoryDir", () => {
  it("stores project memory under data/memory with a project hash", () => {
    const a = getProjectMemoryDir(join("C:", "work", "alpha"));
    const b = getProjectMemoryDir(join("C:", "work", "beta"));

    expect(a).toContain(join("data", "memory", "alpha-"));
    expect(b).toContain(join("data", "memory", "beta-"));
    expect(a).not.toBe(b);
  });
});

describe("Native plugin paths", () => {
  it("keeps cache, data, sources and installed state under OPENHARNESS_CONFIG_DIR", () => {
    const previous = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = join("C:", "tmp", "openharness-test");
    try {
      const root = join(process.env.OPENHARNESS_CONFIG_DIR, "plugins");
      expect(getPluginCacheDir()).toBe(join(root, "cache"));
      expect(getPluginDataDir()).toBe(join(root, "data"));
      expect(getPluginSourcesDir()).toBe(join(root, "sources"));
      expect(getInstalledPluginStorePath()).toBe(join(root, "installed.json"));
    } finally {
      if (previous === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
      else process.env.OPENHARNESS_CONFIG_DIR = previous;
    }
  });
});
