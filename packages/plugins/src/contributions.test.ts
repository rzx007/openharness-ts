import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginManifestSchema } from "./discovery.js";
import { loadPluginSkills, loadPluginCommands } from "./contributions.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ohs-contrib-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function manifest(extra: Record<string, unknown> = {}) {
  return PluginManifestSchema.parse({ name: "my-plugin", ...extra });
}

function write(rel: string, content: string): void {
  const full = join(tmp, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("loadPluginSkills", () => {
  it("loads per-subdirectory SKILL.md layout with source=plugin", async () => {
    write("skills/deploy/SKILL.md", "---\ndescription: Deploy things\n---\nDeploy body.");
    write("skills/rollback/SKILL.md", "# Rollback\nRoll back releases.");
    write("skills/notes.md", "not a skill"); // 非 SKILL.md 布局，忽略

    const skills = await loadPluginSkills(tmp, manifest());
    // name 沿用 TS skills 包语义（frontmatter/标题可覆盖）；commandName 恒为目录名。
    expect(skills.map((s) => s.commandName).sort()).toEqual(["deploy", "rollback"]);
    expect(skills.map((s) => s.name).sort()).toEqual(["Rollback", "deploy"]);
    const deploy = skills.find((s) => s.name === "deploy")!;
    expect(deploy.source).toBe("plugin");
    expect(deploy.description).toBe("Deploy things");
    expect(deploy.content).toContain("Deploy body.");
    expect(deploy.path).toBe(join(tmp, "skills", "deploy", "SKILL.md"));
  });

  it("loads a direct SKILL.md at skills_dir root as a single skill", async () => {
    write("skills/SKILL.md", "---\nname: solo\ndescription: One skill\n---\nBody");
    const skills = await loadPluginSkills(tmp, manifest());
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("solo");
  });

  it("respects a custom skills_dir and returns [] when missing", async () => {
    write("myskills/a/SKILL.md", "A skill.");
    expect(await loadPluginSkills(tmp, manifest({ skills_dir: "myskills" }))).toHaveLength(1);
    expect(await loadPluginSkills(tmp, manifest({ skills_dir: "nope" }))).toEqual([]);
  });
});

describe("loadPluginCommands (default commands/ dir)", () => {
  it("loads .md files with plugin-prefixed names and frontmatter metadata", async () => {
    write("commands/lint.md", "---\ndescription: Lint it\nargument-hint: '[path]'\nmodel: gpt-x\n---\nRun lint.");
    const commands = await loadPluginCommands(tmp, manifest());
    expect(commands).toHaveLength(1);
    const cmd = commands[0]!;
    expect(cmd.name).toBe("my-plugin:lint");
    expect(cmd.description).toBe("Lint it");
    expect(cmd.argumentHint).toBe("[path]");
    expect(cmd.model).toBe("gpt-x");
    expect(cmd.content).toContain("Run lint.");
    expect(cmd.source).toBe("plugin");
    expect(cmd.isSkill).toBe(false);
  });

  it("namespaces nested directories with colons", async () => {
    write("commands/git/commit.md", "Commit helper.");
    const commands = await loadPluginCommands(tmp, manifest());
    expect(commands[0]!.name).toBe("my-plugin:git:commit");
  });

  it("a directory containing SKILL.md becomes one skill-command, children pruned", async () => {
    write("commands/wizard/SKILL.md", "---\ndescription: Wizard\n---\nWizard body");
    write("commands/wizard/extra.md", "should be pruned");
    write("commands/wizard/sub/deep.md", "also pruned");
    const commands = await loadPluginCommands(tmp, manifest());
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("my-plugin:wizard");
    expect(commands[0]!.isSkill).toBe(true);
    expect(commands[0]!.baseDir).toBe(join(tmp, "commands", "wizard"));
  });

  it("falls back description to first heading when frontmatter lacks one", async () => {
    write("commands/x.md", "# Do X things\nbody");
    const commands = await loadPluginCommands(tmp, manifest());
    expect(commands[0]!.description).toBe("Do X things");
  });
});

describe("loadPluginCommands (manifest forms)", () => {
  it("string/array form: loads .md files and directories", async () => {
    write("extra/one.md", "One.");
    write("more/two.md", "Two.");
    const commands = await loadPluginCommands(tmp, manifest({ commands: ["extra/one.md", "more"] }));
    expect(commands.map((c) => c.name).sort()).toEqual(["my-plugin:one", "my-plugin:two"]);
  });

  it("dict form with source: loads the file under the given command name with metadata override", async () => {
    write("impl/real.md", "---\ndescription: from frontmatter\n---\nBody.");
    const commands = await loadPluginCommands(
      tmp,
      manifest({ commands: { ship: { source: "impl/real.md", description: "from manifest" } } }),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("my-plugin:ship");
    expect(commands[0]!.description).toBe("from manifest");
  });

  it("dict form with inline content needs no file", async () => {
    const commands = await loadPluginCommands(
      tmp,
      manifest({ commands: { fix: { content: "Just fix it.", description: "Fixer" } } }),
    );
    expect(commands[0]!.name).toBe("my-plugin:fix");
    expect(commands[0]!.content).toBe("Just fix it.");
    expect(commands[0]!.description).toBe("Fixer");
  });

  it("dedupes when manifest paths overlap the default commands dir", async () => {
    write("commands/lint.md", "Lint.");
    const commands = await loadPluginCommands(tmp, manifest({ commands: ["commands"] }));
    expect(commands).toHaveLength(1);
  });
});
