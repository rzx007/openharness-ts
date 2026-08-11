import { describe, expect, it, vi } from "vitest";

import {
  buildChildAgentWorktreeSlug,
  computeChildAgentWorktreeBaseDir,
  createChildAgentWorktreeManager,
} from "./child-environment.js";

describe("child environment worktrees", () => {
  it("builds stable safe directory keys and bounded unique slugs", () => {
    const base = computeChildAgentWorktreeBaseDir("C:\\Repo\\Project", "C:\\config");
    const first = buildChildAgentWorktreeSlug({ team: "Core Team", agent: "Explore", nonce: "one" });
    const second = buildChildAgentWorktreeSlug({ team: "Core Team", agent: "Explore", nonce: "two" });

    expect(base).toContain("worktrees");
    expect(first).toMatch(/^core-team-explore-/);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second).not.toBe(first);
  });

  it("creates and removes a git worktree through the injected runner", async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
      if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const manager = createChildAgentWorktreeManager({ cwd: "/repo", configDir: "/config", runGit });

    expect(await manager.isGitRepo()).toBe(true);
    const created = await manager.create("team-agent-123");
    await manager.remove(created.slug);

    expect(created.branch).toBe("worktree-team-agent-123");
    expect(runGit).toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add", "-B", created.branch]),
      expect.any(String),
    );
  });
});
