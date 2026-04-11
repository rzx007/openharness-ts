import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginLoader, PluginInstaller, PluginManifestSchema } from "../src/index.js";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  rm: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

const mockedReadFile = vi.mocked(fs.readFile);
const mockedReaddir = vi.mocked(fs.readdir);
const mockedStat = vi.mocked(fs.stat);
const mockedRm = vi.mocked(fs.rm);
const mockedMkdir = vi.mocked(fs.mkdir);

describe("PluginManifestSchema", () => {
  it("validates a valid manifest", () => {
    const result = PluginManifestSchema.safeParse({
      name: "test-plugin",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing name", () => {
    const result = PluginManifestSchema.safeParse({
      version: "1.0.0",
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional description", () => {
    const result = PluginManifestSchema.safeParse({
      name: "test",
      version: "1.0.0",
      description: "A test plugin",
    });
    expect(result.success).toBe(true);
  });
});

describe("PluginLoader", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("loads a plugin from a valid path", async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ name: "my-plugin", version: "1.0.0" })
    );
    const loader = new PluginLoader();
    const result = await loader.loadFromPath("/plugins/my-plugin");
    expect(result.loaded).toBe(true);
    expect(result.manifest.name).toBe("my-plugin");
    expect(result.manifest.version).toBe("1.0.0");
    expect(loader.get("my-plugin")).toBe(result);
  });

  it("returns error for invalid manifest", async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ name: "" }));
    const loader = new PluginLoader();
    const result = await loader.loadFromPath("/plugins/bad");
    expect(result.loaded).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error for unreadable path", async () => {
    mockedReadFile.mockRejectedValue(new Error("not found"));
    const loader = new PluginLoader();
    const result = await loader.loadFromPath("/plugins/missing");
    expect(result.loaded).toBe(false);
  });

  it("loadMany loads multiple plugins", async () => {
    mockedReadFile
      .mockResolvedValueOnce(JSON.stringify({ name: "a", version: "1.0.0" }))
      .mockResolvedValueOnce(JSON.stringify({ name: "b", version: "2.0.0" }));
    const loader = new PluginLoader();
    const results = await loader.loadMany(["/p/a", "/p/b"]);
    expect(results).toHaveLength(2);
    expect(results[0].loaded).toBe(true);
    expect(results[1].loaded).toBe(true);
  });

  it("unload removes a loaded plugin", async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ name: "x", version: "1.0.0" })
    );
    const loader = new PluginLoader();
    await loader.loadFromPath("/p/x");
    expect(loader.get("x")).toBeDefined();
    loader.unload("x");
    expect(loader.get("x")).toBeUndefined();
  });

  it("getLoaded returns all loaded plugins", async () => {
    mockedReadFile
      .mockResolvedValueOnce(JSON.stringify({ name: "a", version: "1.0.0" }))
      .mockResolvedValueOnce(JSON.stringify({ name: "b", version: "1.0.0" }));
    const loader = new PluginLoader();
    await loader.loadMany(["/p/a", "/p/b"]);
    expect(loader.getLoaded()).toHaveLength(2);
  });
});

describe("PluginInstaller", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("install creates directory and manifest", async () => {
    mockedMkdir.mockResolvedValue(undefined);
    const { default: path } = await import("node:path");
    const installer = new PluginInstaller("/plugins");
    const result = await installer.install("my-plugin");
    expect(result).toContain("my-plugin");
    expect(mockedMkdir).toHaveBeenCalled();
  });

  it("uninstall removes existing directory", async () => {
    mockedStat.mockResolvedValue({} as any);
    mockedRm.mockResolvedValue(undefined);
    const installer = new PluginInstaller("/plugins");
    const result = await installer.uninstall("my-plugin");
    expect(result).toBe(true);
    expect(mockedRm).toHaveBeenCalled();
  });

  it("uninstall returns false for non-existent", async () => {
    mockedStat.mockRejectedValue(new Error("not found"));
    const installer = new PluginInstaller("/plugins");
    const result = await installer.uninstall("nope");
    expect(result).toBe(false);
  });

  it("listInstalled returns directory names", async () => {
    mockedReaddir.mockResolvedValue(["plugin-a", "plugin-b", "readme.txt"] as any);
    mockedStat.mockImplementation(async (p) => {
      const str = String(p);
      if (str.endsWith(".txt")) return { isDirectory: () => false } as any;
      return { isDirectory: () => true } as any;
    });
    const installer = new PluginInstaller("/plugins");
    const list = await installer.listInstalled();
    expect(list).toEqual(["plugin-a", "plugin-b"]);
  });

  it("listInstalled returns empty on error", async () => {
    mockedReaddir.mockRejectedValue(new Error("not found"));
    const installer = new PluginInstaller("/plugins");
    const list = await installer.listInstalled();
    expect(list).toEqual([]);
  });
});
