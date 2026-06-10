import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SkillRegistry,
  SkillLoader,
  parseSkillMarkdown,
  BUNDLED_SKILLS,
  type SkillDefinition,
} from "../src/index.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** 构造一个最小 SkillDefinition（补齐新增必填字段的默认值）。 */
function makeSkill(partial: Partial<SkillDefinition> & { name: string }): SkillDefinition {
  return {
    description: "",
    content: "",
    path: "",
    userInvocable: true,
    disableModelInvocation: false,
    ...partial,
  };
}

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
    const skill = makeSkill({ name: "test", description: "desc", content: "body", path: "/test.md" });
    reg.register(skill);
    expect(reg.get("test")).toBe(skill);
  });

  it("overwrites on duplicate register (last-writer-wins)", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "x", description: "v1", content: "a", path: "/a.md" }));
    reg.register(makeSkill({ name: "x", description: "v2", content: "b", path: "/b.md" }));
    expect(reg.get("x")!.description).toBe("v2");
  });

  it("has returns true/false", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "x", path: "/x.md" }));
    expect(reg.has("x")).toBe(true);
    expect(reg.has("y")).toBe(false);
  });

  it("unregister removes skill", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "x", path: "/x.md" }));
    reg.unregister("x");
    expect(reg.has("x")).toBe(false);
  });

  it("getAll returns sorted skills", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "beta", path: "/b.md" }));
    reg.register(makeSkill({ name: "alpha", path: "/a.md" }));
    const all = reg.getAll();
    expect(all[0].name).toBe("alpha");
    expect(all[1].name).toBe("beta");
  });

  it("resolveContent returns skill content", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "x", content: "hello", path: "/x.md" }));
    expect(reg.resolveContent("x")).toBe("hello");
    expect(reg.resolveContent("nope")).toBeUndefined();
  });
});

describe("SkillRegistry.modelVisibleList", () => {
  it("maps to {name, description} and is sorted by name", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "beta", description: "B desc" }));
    reg.register(makeSkill({ name: "alpha", description: "A desc" }));
    const list = reg.modelVisibleList();
    expect(list).toEqual([
      { name: "alpha", description: "A desc" },
      { name: "beta", description: "B desc" },
    ]);
  });

  it("excludes skills with disableModelInvocation=true", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "visible", description: "v" }));
    reg.register(
      makeSkill({ name: "hidden", description: "h", disableModelInvocation: true }),
    );
    const list = reg.modelVisibleList();
    expect(list.map((s) => s.name)).toEqual(["visible"]);
  });

  it("includes userInvocable=false skills as long as model invocation is allowed", () => {
    const reg = new SkillRegistry();
    // user 不可调但模型可见：仍应出现在 model-visible 列表里
    reg.register(makeSkill({ name: "modelonly", description: "m", userInvocable: false }));
    expect(reg.modelVisibleList().map((s) => s.name)).toEqual(["modelonly"]);
  });

  it("returns empty list for an empty registry", () => {
    expect(new SkillRegistry().modelVisibleList()).toEqual([]);
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

describe("parseSkillMarkdown extended frontmatter", () => {
  it("defaults: userInvocable=true, disableModelInvocation=false, others undefined", () => {
    const r = parseSkillMarkdown("d", "# d\n\nbody");
    expect(r.userInvocable).toBe(true);
    expect(r.disableModelInvocation).toBe(false);
    expect(r.model).toBeUndefined();
    expect(r.argumentHint).toBeUndefined();
    expect(r.commandName).toBeUndefined();
    expect(r.displayName).toBeUndefined();
  });

  it("parses all extended fields (hyphen style)", () => {
    const md = [
      "---",
      "name: x",
      "description: a skill",
      "user-invocable: false",
      "disable-model-invocation: true",
      "model: claude-opus-4-8",
      "argument-hint: <file>",
      "command-name: xcmd",
      "display-name: The X",
      "---",
      "",
      "body",
    ].join("\n");
    const r = parseSkillMarkdown("default", md);
    expect(r.userInvocable).toBe(false);
    expect(r.disableModelInvocation).toBe(true);
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.argumentHint).toBe("<file>");
    expect(r.commandName).toBe("xcmd");
    expect(r.displayName).toBe("The X");
  });

  it("tolerates underscore key style (user_invocable etc.)", () => {
    const md = [
      "---",
      "name: x",
      "description: d",
      "user_invocable: no",
      "disable_model_invocation: yes",
      "argument_hint: foo",
      "command_name: c",
      "display_name: D",
      "---",
      "body",
    ].join("\n");
    const r = parseSkillMarkdown("default", md);
    expect(r.userInvocable).toBe(false);
    expect(r.disableModelInvocation).toBe(true);
    expect(r.argumentHint).toBe("foo");
    expect(r.commandName).toBe("c");
    expect(r.displayName).toBe("D");
  });

  it("boolean parsing covers true/1/yes/on and false/0/no/off", () => {
    const cases: Array<[string, boolean]> = [
      ["true", true], ["1", true], ["yes", true], ["on", true],
      ["TRUE", true], ["Yes", true],
      ["false", false], ["0", false], ["no", false], ["off", false],
      ["FALSE", false], ["No", false],
    ];
    for (const [raw, expected] of cases) {
      const md = `---\nname: x\ndescription: d\nuser-invocable: ${raw}\n---\nbody`;
      expect(parseSkillMarkdown("default", md).userInvocable).toBe(expected);
    }
  });

  it("falls back to defaults on unrecognized boolean value", () => {
    const md = "---\nname: x\ndescription: d\nuser-invocable: maybe\n---\nbody";
    expect(parseSkillMarkdown("default", md).userInvocable).toBe(true);
  });
});

describe("BUNDLED_SKILLS", () => {
  it("is non-empty", () => {
    expect(BUNDLED_SKILLS.length).toBeGreaterThan(0);
  });

  it("contains the five first-release skills", () => {
    const names = BUNDLED_SKILLS.map((s) => s.name).sort();
    expect(names).toEqual(["commit", "debug", "plan", "review", "test"]);
  });

  it("every bundled skill has valid fields", () => {
    for (const s of BUNDLED_SKILLS) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.content.trim().length).toBeGreaterThan(0);
      expect(s.source).toBe("bundled");
      expect(s.userInvocable).toBe(true);
      expect(s.disableModelInvocation).toBe(false);
    }
  });
});

describe("SkillRegistry.registerBundled + source priority", () => {
  it("registerBundled registers every bundled skill", () => {
    const reg = new SkillRegistry();
    reg.registerBundled();
    for (const s of BUNDLED_SKILLS) {
      expect(reg.has(s.name)).toBe(true);
    }
  });

  it("user overrides bundled, project overrides user (last-writer-wins)", () => {
    const reg = new SkillRegistry();
    // bundled first
    reg.registerBundled();
    expect(reg.get("commit")!.source).toBe("bundled");
    // user wins over bundled
    reg.register(makeSkill({ name: "commit", description: "user", source: "user", content: "u" }));
    expect(reg.get("commit")!.source).toBe("user");
    // project wins over user
    reg.register(makeSkill({ name: "commit", description: "project", source: "project", content: "p" }));
    expect(reg.get("commit")!.source).toBe("project");
    expect(reg.get("commit")!.content).toBe("p");
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
