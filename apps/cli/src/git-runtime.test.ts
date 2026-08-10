import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeWorktreeBaseDir, nodeRunGit, resolveRepoRoot } from "./git-runtime.js";

describe("computeWorktreeBaseDir", () => {
  it("puts worktrees under <configDir>/worktrees/<repoId>", () => {
    const base = computeWorktreeBaseDir("/home/me/proj", "/cfg");
    expect(base.replace(/\\/g, "/")).toMatch(/^\/cfg\/worktrees\/[0-9a-f]{12}$/);
  });

  it("uses a 12-char sha1 prefix of the normalized repoRoot as repoId", () => {
    const repoRoot = "/home/me/proj";
    const key = process.platform === "win32" ? repoRoot.toLowerCase() : repoRoot;
    const expected = createHash("sha1").update(key).digest("hex").slice(0, 12);
    const base = computeWorktreeBaseDir(repoRoot, "/cfg");
    expect(base.replace(/\\/g, "/")).toBe(`/cfg/worktrees/${expected}`);
  });

  it("is stable across trailing slash and separator differences", () => {
    const a = computeWorktreeBaseDir("/home/me/proj", "/cfg");
    const b = computeWorktreeBaseDir("/home/me/proj/", "/cfg");
    expect(a).toBe(b);
  });

  it("distinguishes different repos", () => {
    const a = computeWorktreeBaseDir("/home/me/proj-a", "/cfg");
    const b = computeWorktreeBaseDir("/home/me/proj-b", "/cfg");
    expect(a).not.toBe(b);
  });
});

describe("nodeRunGit", () => {
  it("returns {code,stdout,stderr} for a successful git command", async () => {
    const { code, stdout } = await nodeRunGit(["--version"], process.cwd());
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain("git version");
  });

  it("returns a non-zero code for an unknown subcommand", async () => {
    const { code } = await nodeRunGit(["definitely-not-a-git-command"], process.cwd());
    expect(code).not.toBe(0);
  });
});

describe("resolveRepoRoot", () => {
  it("resolves a non-empty repository root", async () => {
    const top = await resolveRepoRoot(process.cwd());
    expect(top.length).toBeGreaterThan(0);
  });

  it("falls back to cwd outside a repository", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "oh-nonrepo-"));
    try {
      writeFileSync(join(nonRepo, ".git"), "gitdir: ./not-a-real-git-dir\n");
      expect(await resolveRepoRoot(nonRepo)).toBe(nonRepo);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
