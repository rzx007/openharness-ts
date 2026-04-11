import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSystemPrompt, discoverClaudeMd, getBaseSystemPrompt, formatEnvironmentSection, buildRuntimeSystemPrompt } from "./index.js";
import type { EnvironmentInfo } from "./index.js";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

const mockedAccess = vi.mocked(fs.access);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedReaddir = vi.mocked(fs.readdir);

describe("discoverClaudeMd", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns CLAUDE.md content from project root", async () => {
    mockedAccess.mockImplementation(async () => {});
    mockedReadFile.mockResolvedValue("# Project rules\nDo good things");
    const result = await discoverClaudeMd("/project");
    expect(result).toBe("# Project rules\nDo good things");
  });

  it("returns null when no CLAUDE.md found", async () => {
    mockedAccess.mockRejectedValue(new Error("not found"));
    const result = await discoverClaudeMd("/project");
    expect(result).toBeNull();
  });

  it("tries .openharness/CLAUDE.md as fallback", async () => {
    let callCount = 0;
    mockedAccess.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("not found");
    });
    mockedReadFile.mockResolvedValue("fallback content");
    const result = await discoverClaudeMd("/project");
    expect(result).toBe("fallback content");
  });
});

describe("getBaseSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = getBaseSystemPrompt();
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain("OpenHarness");
  });
});

describe("formatEnvironmentSection", () => {
  it("formats env info with git branch", () => {
    const env: EnvironmentInfo = {
      osName: "Linux",
      osVersion: "linux",
      platformMachine: "x86_64",
      shell: "bash",
      cwd: "/project",
      homeDir: "/home/user",
      date: "2026-04-11",
      nodeVersion: "v20.0.0",
      isGitRepo: true,
      gitBranch: "main",
      hostname: "dev",
    };
    const section = formatEnvironmentSection(env);
    expect(section).toContain("Linux");
    expect(section).toContain("bash");
    expect(section).toContain("/project");
    expect(section).toContain("main");
  });

  it("formats env info without git", () => {
    const env: EnvironmentInfo = {
      osName: "Windows",
      osVersion: "win32",
      platformMachine: "x64",
      shell: "cmd.exe",
      cwd: "C:\\project",
      homeDir: "C:\\Users",
      date: "2026-04-11",
      nodeVersion: "v20.0.0",
      isGitRepo: false,
      hostname: "pc",
    };
    const section = formatEnvironmentSection(env);
    expect(section).toContain("Windows");
    expect(section).not.toContain("Git: yes");
  });
});

describe("buildRuntimeSystemPrompt", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("includes fast mode section", async () => {
    mockedAccess.mockRejectedValue(new Error("not found"));
    const result = await buildRuntimeSystemPrompt({ fastMode: true });
    expect(result).toContain("Fast mode");
  });

  it("includes reasoning settings", async () => {
    mockedAccess.mockRejectedValue(new Error("not found"));
    const result = await buildRuntimeSystemPrompt({ effort: "high", passes: 3 });
    expect(result).toContain("high");
    expect(result).toContain("3");
  });

  it("includes skills list", async () => {
    mockedAccess.mockRejectedValue(new Error("not found"));
    const result = await buildRuntimeSystemPrompt({
      skillsList: [{ name: "react", description: "React patterns" }],
    });
    expect(result).toContain("react");
    expect(result).toContain("React patterns");
  });

  it("includes memory content", async () => {
    mockedAccess.mockRejectedValue(new Error("not found"));
    const result = await buildRuntimeSystemPrompt({ memoryContent: "remember this" });
    expect(result).toContain("remember this");
  });
});
