import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillRegistry, SkillLoader, parseSkillMarkdown } from "../src/index.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

const mockedReadFile = vi.mocked(fs.readFile);
const mockedReaddir = vi.mocked(fs.readdir);

describe("SkillRegistry", () => {
  it("registers and retrieves a skill", () => {
    const reg = new SkillRegistry();
    const skill = { name: "test", description: "desc", content: "body", path: "/test.md" };
    reg.register(skill);
    expect(reg.get("test")).toBe(skill);
  });

  it("overwrites on duplicate register (last-writer-wins)", () => {
    const reg = new SkillRegistry();
    reg.register({ name: "x", description: "v1", content: "a", path: "/a.md" });
    reg.register({ name: "x", description: "v2", content: "b", path: "/b.md" });
    expect(reg.get("x")!.description).toBe("v2");
  });

  it("has returns true/false", () => {
    const reg = new SkillRegistry();
    reg.register({ name: "x", description: "", content: "", path: "/x.md" });
    expect(reg.has("x")).toBe(true);
    expect(reg.has("y")).toBe(false);
  });

  it("unregister removes skill", () => {
    const reg = new SkillRegistry();
    reg.register({ name: "x", description: "", content: "", path: "/x.md" });
    reg.unregister("x");
    expect(reg.has("x")).toBe(false);
  });

  it("getAll returns sorted skills", () => {
    const reg = new SkillRegistry();
    reg.register({ name: "beta", description: "", content: "", path: "/b.md" });
    reg.register({ name: "alpha", description: "", content: "", path: "/a.md" });
    const all = reg.getAll();
    expect(all[0].name).toBe("alpha");
    expect(all[1].name).toBe("beta");
  });

  it("resolveContent returns skill content", () => {
    const reg = new SkillRegistry();
    reg.register({ name: "x", description: "", content: "hello", path: "/x.md" });
    expect(reg.resolveContent("x")).toBe("hello");
    expect(reg.resolveContent("nope")).toBeUndefined();
  });
});

describe("parseSkillMarkdown", () => {
  it("extracts name from heading", () => {
    const result = parseSkillMarkdown("default", "# My Skill\n\nSome description here.");
    expect(result.name).toBe("My Skill");
    expect(result.description).toBe("Some description here.");
  });

  it("uses default name when no heading", () => {
    const result = parseSkillMarkdown("myfile", "Just some text without heading.");
    expect(result.name).toBe("myfile");
    expect(result.description).toBe("Just some text without heading.");
  });

  it("parses YAML frontmatter", () => {
    const md = "---\nname: Custom Name\ndescription: A custom skill\n---\n\n# Irrelevant\n\nBody text.";
    const result = parseSkillMarkdown("default", md);
    expect(result.name).toBe("Custom Name");
    expect(result.description).toBe("A custom skill");
  });

  it("frontmatter with quoted values", () => {
    const md = '---\nname: "Quoted Name"\ndescription: \'Quoted desc\'\n---\n\nBody.';
    const result = parseSkillMarkdown("default", md);
    expect(result.name).toBe("Quoted Name");
    expect(result.description).toBe("Quoted desc");
  });

  it("falls back when frontmatter has no description", () => {
    const md = "---\nname: OnlyName\n---\n\n# OnlyName\n\nFirst paragraph after heading.";
    const result = parseSkillMarkdown("default", md);
    expect(result.name).toBe("OnlyName");
    expect(result.description).toBe("First paragraph after heading.");
  });

  it("generates fallback description", () => {
    const result = parseSkillMarkdown("myskill", "# myskill");
    expect(result.description).toBe("Skill: myskill");
  });

  it("truncates long description to 200 chars", () => {
    const longDesc = "x".repeat(300);
    const result = parseSkillMarkdown("default", `# title\n\n${longDesc}`);
    expect(result.description.length).toBe(200);
  });
});

describe("SkillLoader", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("loads a single markdown file", async () => {
    mockedReadFile.mockResolvedValue("# Test Skill\n\nA test description.");
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skill = await loader.loadFromMarkdown("/skills/test.md");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("Test Skill");
    expect(skill!.description).toBe("A test description.");
    expect(reg.has("Test Skill")).toBe(true);
  });

  it("returns undefined for unreadable file", async () => {
    mockedReadFile.mockRejectedValue(new Error("not found"));
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skill = await loader.loadFromMarkdown("/skills/missing.md");
    expect(skill).toBeUndefined();
  });

  it("uses filename as default name when no heading", async () => {
    mockedReadFile.mockResolvedValue("Just some content without a heading.");
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skill = await loader.loadFromMarkdown("/skills/myutil.md");
    expect(skill!.name).toBe("myutil");
  });

  it("loads all skills from a directory", async () => {
    mockedReaddir.mockResolvedValue([
      { name: "alpha.md", isFile: () => true, isDirectory: () => false } as any,
      { name: "beta.md", isFile: () => true, isDirectory: () => false } as any,
      { name: "notes.txt", isFile: () => true, isDirectory: () => false } as any,
    ]);
    mockedReadFile
      .mockResolvedValueOnce("# Alpha\n\nAlpha skill")
      .mockResolvedValueOnce("# Beta\n\nBeta skill");
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skills = await loader.loadFromDirectory("/skills");
    expect(skills).toHaveLength(2);
    expect(reg.has("Alpha")).toBe(true);
    expect(reg.has("Beta")).toBe(true);
  });

  it("returns empty for non-existent directory", async () => {
    mockedReaddir.mockRejectedValue(new Error("not found"));
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skills = await loader.loadFromDirectory("/nope");
    expect(skills).toHaveLength(0);
  });

  it("recursive discovery enters subdirectories", async () => {
    mockedReaddir
      .mockResolvedValueOnce([
        { name: "sub", isFile: () => false, isDirectory: () => true } as any,
      ])
      .mockResolvedValueOnce([
        { name: "deep.md", isFile: () => true, isDirectory: () => false } as any,
      ]);
    mockedReadFile.mockResolvedValue("# Deep\n\nDeep skill");
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skills = await loader.loadFromDirectory("/skills", true);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("Deep");
  });
});
