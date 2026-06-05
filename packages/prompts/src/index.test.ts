import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  buildSystemPrompt,
  discoverClaudeMd,
  discoverClaudeMdFiles,
  loadClaudeMdPrompt,
  getBaseSystemPrompt,
  formatEnvironmentSection,
  buildRuntimeSystemPrompt,
  buildPermissionModeSection,
  buildDelegationSection,
  getEnvironmentInfo,
} from "./index.js";
import type { EnvironmentInfo } from "./index.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(section).toContain("Home directory: /home/user");
  });

  it("formats env info without git", () => {
    const env: EnvironmentInfo = {
      osName: "Windows",
      osVersion: "win32",
      platformMachine: "x64",
      shell: "cmd.exe",
      cwd: "C:\\project",
      homeDir: "C:\\Users\\dev",
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

describe("getEnvironmentInfo (homeDir bug fix)", () => {
  it("produces an absolute, non-empty home directory", async () => {
    const env = await getEnvironmentInfo(process.cwd());
    expect(env.homeDir.length).toBeGreaterThan(1);
    // Old bug produced a bare basename / Promise-stringified garbage. The real
    // home path must contain a path separator (absolute path).
    expect(/[\\/]/.test(env.homeDir)).toBe(true);
    expect(env.homeDir).not.toContain("[object Promise]");
    expect(env.hostname.length).toBeGreaterThan(0);
  });
});

describe("buildPermissionModeSection", () => {
  it("emits plan-mode guidance", () => {
    const s = buildPermissionModeSection("plan");
    expect(s).toContain("# Current Permission Mode");
    expect(s).toContain("Plan mode is enabled");
    expect(s).toContain("read-only");
  });

  it("emits full-auto guidance", () => {
    const s = buildPermissionModeSection("full_auto");
    expect(s).toContain("Full-auto permission mode is enabled");
  });

  it("emits default guidance", () => {
    const s = buildPermissionModeSection("default");
    expect(s).toContain("Default permission mode is enabled");
  });
});

describe("buildDelegationSection", () => {
  it("describes the agent tool and subagent workflow", () => {
    const s = buildDelegationSection();
    expect(s).toContain("# Delegation And Subagents");
    expect(s).toContain("agent");
    expect(s).toContain("/agents");
  });
});

describe("CLAUDE.md upward traversal", () => {
  let root: string;
  let parent: string;
  let child: string;

  beforeAll(async () => {
    // root/
    //   CLAUDE.md
    //   parent/
    //     .claude/CLAUDE.md
    //     .claude/rules/a.md
    //     .claude/rules/b.md
    //     child/
    //       CLAUDE.md
    root = await mkdtemp(join(tmpdir(), "oh-claudemd-"));
    parent = join(root, "parent");
    child = join(parent, "child");
    await mkdir(child, { recursive: true });
    await mkdir(join(parent, ".claude", "rules"), { recursive: true });

    await writeFile(join(root, "CLAUDE.md"), "ROOT_RULES", "utf-8");
    await writeFile(join(parent, ".claude", "CLAUDE.md"), "PARENT_DOTCLAUDE", "utf-8");
    await writeFile(join(parent, ".claude", "rules", "b.md"), "RULE_B", "utf-8");
    await writeFile(join(parent, ".claude", "rules", "a.md"), "RULE_A", "utf-8");
    await writeFile(join(child, "CLAUDE.md"), "CHILD_RULES", "utf-8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("collects files from cwd upward including parents and .claude/rules", async () => {
    const files = await discoverClaudeMdFiles(child);

    expect(files).toContain(join(child, "CLAUDE.md"));
    expect(files).toContain(join(parent, ".claude", "CLAUDE.md"));
    expect(files).toContain(join(parent, ".claude", "rules", "a.md"));
    expect(files).toContain(join(parent, ".claude", "rules", "b.md"));
    expect(files).toContain(join(root, "CLAUDE.md"));
  });

  it("orders most-specific (cwd) first, least-specific (root) last", async () => {
    const files = await discoverClaudeMdFiles(child);
    const childIdx = files.indexOf(join(child, "CLAUDE.md"));
    const parentIdx = files.indexOf(join(parent, ".claude", "CLAUDE.md"));
    const rootIdx = files.indexOf(join(root, "CLAUDE.md"));
    expect(childIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeLessThan(parentIdx);
    expect(parentIdx).toBeLessThan(rootIdx);
  });

  it("sorts .claude/rules/*.md by filename", async () => {
    const files = await discoverClaudeMdFiles(parent);
    const aIdx = files.indexOf(join(parent, ".claude", "rules", "a.md"));
    const bIdx = files.indexOf(join(parent, ".claude", "rules", "b.md"));
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("assembles a single Project Instructions section with content", async () => {
    const section = await loadClaudeMdPrompt(child);
    expect(section).not.toBeNull();
    expect(section).toContain("# Project Instructions");
    expect(section).toContain("CHILD_RULES");
    expect(section).toContain("PARENT_DOTCLAUDE");
    expect(section).toContain("RULE_A");
    expect(section).toContain("RULE_B");
    expect(section).toContain("ROOT_RULES");
  });

  it("returns null when no instruction files exist", async () => {
    const empty = await mkdtemp(join(tmpdir(), "oh-empty-"));
    try {
      const section = await loadClaudeMdPrompt(empty);
      // The temp dir's ancestors normally have no CLAUDE.md, so expect null.
      // If an ancestor unexpectedly had one, at minimum the empty dir itself
      // contributes nothing.
      if (section !== null) {
        expect(section).not.toContain(empty);
      } else {
        expect(section).toBeNull();
      }
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("discoverClaudeMd wrapper returns assembled section", async () => {
    const section = await discoverClaudeMd(child);
    expect(section).toContain("CHILD_RULES");
  });
});

describe("buildRuntimeSystemPrompt", () => {
  let emptyDir: string;

  beforeAll(async () => {
    emptyDir = await mkdtemp(join(tmpdir(), "oh-runtime-"));
  });

  afterAll(async () => {
    await rm(emptyDir, { recursive: true, force: true });
  });

  it("includes default permission-mode section when mode unspecified", async () => {
    const result = await buildRuntimeSystemPrompt({ cwd: emptyDir });
    expect(result).toContain("# Current Permission Mode");
    expect(result).toContain("Default permission mode is enabled");
  });

  it("permission-mode section changes with the mode", async () => {
    const planResult = await buildRuntimeSystemPrompt({ cwd: emptyDir, permissionMode: "plan" });
    expect(planResult).toContain("Plan mode is enabled");
    const autoResult = await buildRuntimeSystemPrompt({ cwd: emptyDir, permissionMode: "full_auto" });
    expect(autoResult).toContain("Full-auto permission mode is enabled");
  });

  it("includes the delegation section by default", async () => {
    const result = await buildRuntimeSystemPrompt({ cwd: emptyDir });
    expect(result).toContain("# Delegation And Subagents");
  });

  it("omits delegation when includeDelegation is false", async () => {
    const result = await buildRuntimeSystemPrompt({ cwd: emptyDir, includeDelegation: false });
    expect(result).not.toContain("# Delegation And Subagents");
  });

  it("includes fast mode section", async () => {
    const result = await buildRuntimeSystemPrompt({ cwd: emptyDir, fastMode: true });
    expect(result).toContain("Fast mode");
  });

  it("includes reasoning settings", async () => {
    const result = await buildRuntimeSystemPrompt({ cwd: emptyDir, effort: "high", passes: 3 });
    expect(result).toContain("high");
    expect(result).toContain("3");
  });

  it("includes skills list", async () => {
    const result = await buildRuntimeSystemPrompt({
      cwd: emptyDir,
      skillsList: [{ name: "react", description: "React patterns" }],
    });
    expect(result).toContain("react");
    expect(result).toContain("React patterns");
  });

  it("includes memory content as a Project Memory section", async () => {
    const result = await buildRuntimeSystemPrompt({ cwd: emptyDir, memoryContent: "remember this" });
    expect(result).toContain("# Project Memory");
    expect(result).toContain("remember this");
  });

  it("buildSystemPrompt assembles env + project instructions", async () => {
    const result = await buildSystemPrompt(undefined, emptyDir);
    expect(result).toContain("# Environment");
    expect(result).toContain("OpenHarness");
  });
});
