import { describe, it, expect } from "vitest";
import { todoWriteTool } from "../todo-write.js";
import { sleepTool } from "../sleep.js";
import { briefTool } from "../brief.js";
import { configTool } from "../config.js";
import { toolSearchTool } from "../tool-search.js";
import { askUserTool } from "../ask-user.js";
import { listSkillsTool, skillTool } from "../skill.js";
import { ToolRegistry } from "@openharness/core";
import { SkillRegistry, type SkillDefinition } from "@openharness/skills";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

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

describe("todoWriteTool", () => {
  it("appends an unchecked item to TODO.md", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-test-"));
    try {
      await todoWriteTool.execute!({ item: "Fix bug" }, { cwd: dir });
      const content = await fs.readFile(path.join(dir, "TODO.md"), "utf-8");
      expect(content).toContain("- [ ] Fix bug");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("appends a checked item", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-test-"));
    try {
      await todoWriteTool.execute!({ item: "Done task", checked: true }, { cwd: dir });
      const content = await fs.readFile(path.join(dir, "TODO.md"), "utf-8");
      expect(content).toContain("- [x] Done task");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("uses custom path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-test-"));
    try {
      await todoWriteTool.execute!({ item: "Custom", path: "TASKS.md" }, { cwd: dir });
      const content = await fs.readFile(path.join(dir, "TASKS.md"), "utf-8");
      expect(content).toContain("- [ ] Custom");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

describe("sleepTool", () => {
  it("sleeps and returns message", async () => {
    const start = Date.now();
    const result = await sleepTool.execute!({ seconds: 0.01 }, { cwd: process.cwd() });
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as any).text).toContain("Slept");
  });

  it("clamps to 30 seconds max", async () => {
    const result = await sleepTool.execute!({ seconds: 0.01 }, { cwd: process.cwd() });
    expect((result.content[0] as any).text).toContain("0.01");
  });
});

describe("briefTool", () => {
  it("returns text unchanged when short enough", async () => {
    const result = await briefTool.execute!({ text: "Hello world" }, { cwd: process.cwd() });
    expect((result.content[0] as any).text).toBe("Hello world");
  });

  it("truncates long text", async () => {
    const longText = "a".repeat(300);
    const result = await briefTool.execute!({ text: longText, maxChars: 100 }, { cwd: process.cwd() });
    const text = (result.content[0] as any).text;
    expect(text.length).toBeLessThanOrEqual(103);
    expect(text.endsWith("...")).toBe(true);
  });
});

describe("configTool", () => {
  it("shows config", async () => {
    const result = await configTool.execute!({ action: "show" }, { cwd: process.cwd() });
    const text = (result.content[0] as any).text;
    expect(text).toContain("model");
  });
});

describe("toolSearchTool", () => {
  it("finds matching tools", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "Bash",
      description: "Run shell commands",
      inputSchema: {},
      async execute() {
        return { content: [] };
      },
    });
    const result = await toolSearchTool.execute!({ query: "bash" }, { cwd: process.cwd(), toolRegistry: registry });
    const text = (result.content[0] as any).text;
    expect(text).toContain("Bash");
  });

  it("returns no matches message", async () => {
    const registry = new ToolRegistry();
    const result = await toolSearchTool.execute!({ query: "zzznonexistent" }, { cwd: process.cwd(), toolRegistry: registry });
    const text = (result.content[0] as any).text;
    expect(text).toContain("no matches");
  });

  it("uses the current runtime registry instead of creating the default registry", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "PluginDynamicTool",
      description: "Dynamic plugin capability",
      inputSchema: {},
      async execute() {
        return { content: [] };
      },
    });

    const result = await toolSearchTool.execute!({ query: "dynamic" }, { cwd: process.cwd(), toolRegistry: registry });
    const text = (result.content[0] as any).text;
    expect(text).toContain("PluginDynamicTool");
    expect(text).not.toContain("Bash");
  });

  it("fails when no runtime registry is provided", async () => {
    const result = await toolSearchTool.execute!({ query: "bash" }, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("current runtime tool registry");
  });
});

describe("skillTool", () => {
  it("resolves skills by commandName through the shared registry", async () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill({
      name: "do-thing",
      commandName: "dt",
      content: "# do-thing\n\nRun the thing.",
    }));

    const result = await skillTool.execute!({ name: "dt" }, {
      cwd: process.cwd(),
      skillRegistry: registry,
    });

    expect(result.isError).not.toBe(true);
    expect((result.content[0] as any).text).toContain("Run the thing.");
  });
});

describe("listSkillsTool", () => {
  it("lists model-visible skills by default", async () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill({
      name: "visible",
      description: "Visible skill",
      source: "project",
    }));
    registry.register(makeSkill({
      name: "hidden",
      description: "Hidden skill",
      disableModelInvocation: true,
      source: "user",
    }));

    const result = await listSkillsTool.execute!({}, {
      cwd: process.cwd(),
      skillRegistry: registry,
    });

    const text = (result.content[0] as any).text;
    expect(text).toContain("Model-visible skills:");
    expect(text).toContain("visible — Visible skill");
    expect(text).toContain("source=project");
    expect(text).not.toContain("hidden");
  });

  it("can list all loaded skills including model-hidden skills", async () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill({
      name: "visible",
      description: "Visible skill",
      userInvocable: false,
    }));
    registry.register(makeSkill({
      name: "hidden",
      description: "Hidden skill",
      commandName: "h",
      disableModelInvocation: true,
    }));

    const result = await listSkillsTool.execute!({ visibility: "all" }, {
      cwd: process.cwd(),
      skillRegistry: registry,
    });

    const text = (result.content[0] as any).text;
    expect(text).toContain("All loaded skills:");
    expect(text).toContain("visible — Visible skill");
    expect(text).toContain("hidden — Hidden skill");
    expect(text).toContain("command=/h");
    expect(text).toContain("model=hidden");
  });

  it("freshly scans project .claude/skills directory skills even with a stale shared registry", async () => {
    const previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-list-skills-"));
    process.env.OPENHARNESS_CONFIG_DIR = path.join(dir, "config");
    try {
      const skillDir = path.join(dir, ".claude", "skills", "live-skill");
      await fs.mkdir(path.join(dir, ".git"), { recursive: true });
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\ndescription: Fresh project skill\n---\n\nLive skill body.",
        "utf-8",
      );
      await fs.writeFile(path.join(skillDir, "notes.md"), "not a skill", "utf-8");

      const staleRegistry = new SkillRegistry();
      staleRegistry.register(makeSkill({
        name: "stale",
        description: "Existing runtime skill",
      }));

      const result = await listSkillsTool.execute!({ visibility: "all" }, {
        cwd: dir,
        skillRegistry: staleRegistry,
      });

      const text = (result.content[0] as any).text;
      expect(text).toContain("stale — Existing runtime skill");
      expect(text).toContain("live-skill — Fresh project skill");
      expect(text).not.toContain("notes");
    } finally {
      if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
      else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("askUserTool", () => {
  it("returns error when no prompt function available", async () => {
    const result = await askUserTool.execute!({ question: "What?" }, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
  });

  it("calls askUserPrompt when available", async () => {
    const result = await askUserTool.execute!(
      { question: "Name?" },
      { cwd: process.cwd(), askUserPrompt: async () => "Alice" } as any
    );
    expect((result.content[0] as any).text).toBe("Alice");
  });
});
