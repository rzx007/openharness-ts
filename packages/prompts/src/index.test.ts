import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSystemPrompt, discoverClaudeMd } from "../src/index.js";
import type { PromptContext } from "../src/index.js";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  readFile: vi.fn(),
}));

const mockedAccess = vi.mocked(fs.access);
const mockedReadFile = vi.mocked(fs.readFile);

const defaultCtx: PromptContext = {
  cwd: "/project",
  platform: "linux",
  shell: "bash",
  date: "2026-04-11",
};

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

describe("buildSystemPrompt", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("builds prompt without CLAUDE.md", async () => {
    mockedAccess.mockRejectedValue(new Error("not found"));
    const result = await buildSystemPrompt("You are helpful.", defaultCtx);
    expect(result).toContain("You are helpful.");
    expect(result).toContain("Platform: linux");
    expect(result).toContain("Shell: bash");
    expect(result).toContain("Working directory: /project");
  });

  it("builds prompt with CLAUDE.md", async () => {
    mockedAccess.mockImplementation(async () => {});
    mockedReadFile.mockResolvedValue("# Rules\nBe nice");
    const result = await buildSystemPrompt("You are helpful.", defaultCtx);
    expect(result).toContain("Project Context");
    expect(result).toContain("Be nice");
  });
});
