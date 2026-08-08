import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildChildAgentWorktreeSlug,
  computeChildAgentWorktreeBaseDir,
  createChildAgentWorktreeManager,
  type GitRunner,
} from "./child-agent-worktree.js";

describe("child agent worktree helpers", () => {
  it("builds bounded deterministic-prefix slugs", () => {
    const slug = buildChildAgentWorktreeSlug({
      team: "Default Team",
      agent: "Build/Write Agent",
      nonce: "abcd1234",
    });

    expect(slug).toMatch(/^default-team-build-write-agent-[a-f0-9]{8}-abcd1234$/);
    expect(slug.length).toBeLessThanOrEqual(64);
  });

  it("creates a worktree with a scoped path and branch", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const runGit: GitRunner = vi.fn(async (args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "ok", stderr: "" };
    });
    const manager = createChildAgentWorktreeManager({
      cwd: "/repo",
      configDir: "/config",
      runGit,
    });

    const result = await manager.create("team/agent");

    const baseDir = computeChildAgentWorktreeBaseDir("/repo", "/config");
    expect(result).toEqual({
      slug: "team/agent",
      path: join(baseDir, "team+agent"),
      branch: "worktree-team+agent",
      created: true,
    });
    expect(calls.at(-1)).toEqual({
      cwd: "/repo",
      args: ["worktree", "add", "-B", "worktree-team+agent", join(baseDir, "team+agent"), "HEAD"],
    });
  });

  it("reuses an existing managed worktree path", async () => {
    const baseDir = computeChildAgentWorktreeBaseDir("/repo", "/config");
    const existingPath = join(baseDir, "team+agent");
    const runGit: GitRunner = vi.fn(async (args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: [
            `worktree ${existingPath}`,
            "HEAD abc123",
            "branch refs/heads/worktree-team+agent",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    });
    const manager = createChildAgentWorktreeManager({
      cwd: "/repo",
      configDir: "/config",
      runGit,
    });

    await expect(manager.create("team/agent")).resolves.toEqual({
      slug: "team/agent",
      path: existingPath,
      branch: "worktree-team+agent",
      created: false,
    });
  });

  it("rejects unsafe slugs before invoking git", async () => {
    const runGit: GitRunner = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const manager = createChildAgentWorktreeManager({
      cwd: "/repo",
      configDir: "/config",
      runGit,
    });

    await expect(manager.create("../escape")).rejects.toThrow("Invalid worktree slug");
    await expect(manager.remove("/absolute")).rejects.toThrow("absolute path");
    expect(runGit).not.toHaveBeenCalled();
  });
});
