import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorktreeManager,
  validateWorktreeSlug,
  type GitRunner,
} from "./worktree.js";

// ---------------------------------------------------------------------------
// 纯逻辑：slug 校验
// ---------------------------------------------------------------------------

describe("validateWorktreeSlug", () => {
  it("returns valid slug unchanged", () => {
    expect(validateWorktreeSlug("team-explore-ab12")).toBe("team-explore-ab12");
    expect(validateWorktreeSlug("a/b/c")).toBe("a/b/c");
    expect(validateWorktreeSlug("a.b_c+d-e")).toBe("a.b_c+d-e");
  });

  it("rejects empty", () => {
    expect(() => validateWorktreeSlug("")).toThrow(/empty/);
  });

  it("rejects too long (> 64, aligned with Python)", () => {
    expect(validateWorktreeSlug("x".repeat(64))).toBe("x".repeat(64));
    expect(() => validateWorktreeSlug("x".repeat(65))).toThrow(/characters or fewer/);
  });

  it("rejects absolute paths", () => {
    expect(() => validateWorktreeSlug("/etc/passwd")).toThrow(/absolute path/);
    expect(() => validateWorktreeSlug("\\windows")).toThrow(/absolute path/);
  });

  it("rejects . and .. segments", () => {
    expect(() => validateWorktreeSlug("..")).toThrow(/path segments/);
    expect(() => validateWorktreeSlug("a/../b")).toThrow(/path segments/);
    expect(() => validateWorktreeSlug(".")).toThrow(/path segments/);
  });

  it("rejects illegal characters", () => {
    expect(() => validateWorktreeSlug("a b")).toThrow(/each segment/);
    expect(() => validateWorktreeSlug("a$b")).toThrow(/each segment/);
    expect(() => validateWorktreeSlug("a//b")).toThrow(/each segment/);
  });
});

describe("WorktreeManager pure helpers", () => {
  const mgr = new WorktreeManager({
    runGit: async () => ({ code: 0, stdout: "", stderr: "" }),
    baseDir: join("/base"),
    repoRoot: join("/repo"),
  });

  it("computes path and branch with flat slug", () => {
    expect(mgr.branchFor("team-a/name-b")).toBe("worktree-team-a+name-b");
    expect(mgr.pathFor("team-a/name-b")).toBe(join("/base", "team-a+name-b"));
  });
});

// ---------------------------------------------------------------------------
// 真实 git + 临时 repo
// ---------------------------------------------------------------------------

const realRunGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });

describe("WorktreeManager with real git", () => {
  let tmpRoot: string;
  let repoRoot: string;
  let baseDir: string;
  let mgr: WorktreeManager;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "oh-wt-"));
    repoRoot = join(tmpRoot, "repo");
    baseDir = join(tmpRoot, "worktrees");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(baseDir, { recursive: true });

    await realRunGit(["init", "-b", "main"], repoRoot);
    await realRunGit(["config", "user.email", "t@t.test"], repoRoot);
    await realRunGit(["config", "user.name", "Test"], repoRoot);
    await writeFile(join(repoRoot, "README.md"), "hello\n");
    await realRunGit(["add", "."], repoRoot);
    await realRunGit(["commit", "-m", "init"], repoRoot);

    mgr = new WorktreeManager({ runGit: realRunGit, baseDir, repoRoot });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("isGitRepo true for repo, false elsewhere", async () => {
    expect(await mgr.isGitRepo()).toBe(true);
    const nonGit = new WorktreeManager({ runGit: realRunGit, baseDir, repoRoot: tmpRoot });
    expect(await nonGit.isGitRepo()).toBe(false);
  });

  it("create adds worktree with path+branch and list contains it", async () => {
    const res = await mgr.create("team-explore-ab12");
    expect(res.created).toBe(true);
    expect(res.branch).toBe("worktree-team-explore-ab12");
    expect(res.path).toBe(join(baseDir, "team-explore-ab12"));

    const list = await mgr.list();
    const found = list.find((w) => w.path.replace(/\\/g, "/").endsWith("team-explore-ab12"));
    expect(found).toBeDefined();
    expect(found?.branch).toBe("worktree-team-explore-ab12");
    expect(found?.slug).toBe("team-explore-ab12");
  });

  it("create reuses existing worktree (created:false)", async () => {
    await mgr.create("reuse-me-1234");
    const again = await mgr.create("reuse-me-1234");
    expect(again.created).toBe(false);
    expect(again.branch).toBe("worktree-reuse-me-1234");
  });

  it("remove deletes a clean worktree", async () => {
    await mgr.create("clean-wt-0001");
    await mgr.remove("clean-wt-0001");
    const list = await mgr.list();
    expect(list.some((w) => w.path.replace(/\\/g, "/").endsWith("clean-wt-0001"))).toBe(false);
  });

  it("non-force remove of dirty worktree throws (kept)", async () => {
    const res = await mgr.create("dirty-wt-0001");
    // 制造未提交改动
    await writeFile(join(res.path, "scratch.txt"), "uncommitted\n");
    expect(await mgr.hasChanges("dirty-wt-0001")).toBe(true);
    await expect(mgr.remove("dirty-wt-0001")).rejects.toThrow(/git worktree remove failed/);
    // 仍存在
    const list = await mgr.list();
    expect(list.some((w) => w.path.replace(/\\/g, "/").endsWith("dirty-wt-0001"))).toBe(true);
    // force 可清
    await mgr.remove("dirty-wt-0001", { force: true });
  });

  it("create → non-force remove → same slug create again succeeds (-B resets orphan branch)", async () => {
    // 第一次创建 + 干净移除（非 force）。非 force remove 只删工作目录、保留
    // worktree-<slug> 分支 → 若 create 用 `-b` 会撞已存在分支而失败；`-B` 复位它。
    const first = await mgr.create("recycle-slug-9999");
    expect(first.created).toBe(true);
    await mgr.remove("recycle-slug-9999");

    // 同一 slug 再次创建：必须成功（-B 复位了残留分支）。
    const again = await mgr.create("recycle-slug-9999");
    expect(again.created).toBe(true);
    expect(again.branch).toBe("worktree-recycle-slug-9999");
    const list = await mgr.list();
    expect(
      list.some((w) => w.path.replace(/\\/g, "/").endsWith("recycle-slug-9999")),
    ).toBe(true);
  });

  it("create rejects invalid slugs before touching git", async () => {
    await expect(mgr.create("..")).rejects.toThrow(/path segments/);
    await expect(mgr.create("/abs")).rejects.toThrow(/absolute path/);
    await expect(mgr.create("")).rejects.toThrow(/empty/);
  });
});
