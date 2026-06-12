import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginInstaller } from "./index.js";
import * as fs from "node:fs/promises";

// 安装器仍用 fs-mock 风格（轻量 CRUD）；发现/加载的真实文件系统测试见 discovery.test.ts。
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  rm: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

const mockedReaddir = vi.mocked(fs.readdir);
const mockedStat = vi.mocked(fs.stat);
const mockedRm = vi.mocked(fs.rm);
const mockedMkdir = vi.mocked(fs.mkdir);

describe("PluginInstaller", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("install creates directory and manifest", async () => {
    mockedMkdir.mockResolvedValue(undefined);
    const installer = new PluginInstaller("/plugins");
    const result = await installer.install("my-plugin");
    expect(result).toContain("my-plugin");
    expect(mockedMkdir).toHaveBeenCalled();
  });

  it("uninstall removes existing directory", async () => {
    mockedStat.mockResolvedValue({} as never);
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
    mockedReaddir.mockResolvedValue(["plugin-a", "plugin-b", "readme.txt"] as never);
    mockedStat.mockImplementation(async (p) => {
      const str = String(p);
      if (str.endsWith(".txt")) return { isDirectory: () => false } as never;
      return { isDirectory: () => true } as never;
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

  it("uninstall rejects path traversal and absolute names without touching fs", async () => {
    const installer = new PluginInstaller("/plugins");
    expect(await installer.uninstall("../outside")).toBe(false);
    expect(await installer.uninstall("a/b")).toBe(false);
    expect(await installer.uninstall("a\\b")).toBe(false);
    expect(await installer.uninstall("..")).toBe(false);
    expect(await installer.uninstall("/abs")).toBe(false);
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedStat).not.toHaveBeenCalled();
  });

  it("install rejects unsafe target names", async () => {
    const installer = new PluginInstaller("/plugins");
    await expect(installer.install("..")).rejects.toThrow(/Unsafe/);
    // source 取最后一段：path 形式取 basename，仍须安全。
    await expect(installer.install("owner/..")).rejects.toThrow(/Unsafe/);
    expect(mockedMkdir).not.toHaveBeenCalled();
  });
});
