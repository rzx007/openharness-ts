import { join } from "node:path";

/**
 * 注入的 git 运行器：跑一条 git 命令并返回退出码与 stdout/stderr。
 *
 * 解耦真实 child_process，便于单测注入 mock / fake。args 不含开头的 "git"。
 */
export interface GitRunner {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface WorktreeManagerOptions {
  runGit: GitRunner;
  /** worktree 目录的存放根（如 `~/.openharness/worktrees/<repo-id>`）。 */
  baseDir: string;
  /** 主仓库根目录；`git worktree add` 基于这里的当前 HEAD 派生。 */
  repoRoot: string;
}

export interface WorktreeCreateResult {
  slug: string;
  path: string;
  branch: string;
  /** true=新建；false=已存在并复用。 */
  created: boolean;
}

export interface WorktreeListEntry {
  slug?: string;
  path: string;
  branch?: string;
}

// ---------------------------------------------------------------------------
// Slug 校验（移植自 Python validate_worktree_slug，语义一致）
// ---------------------------------------------------------------------------

const VALID_SEGMENT = /^[A-Za-z0-9._+-]+$/;
// 对齐 Python worktree.py（_MAX_SLUG_LENGTH = 64）。
const MAX_SLUG_LENGTH = 64;

/**
 * 校验并原样返回 worktree slug。
 *
 * 规则：
 * - 非空
 * - 长度 <= MAX_SLUG_LENGTH
 * - 不以 `/` 或 `\` 开头（拒绝绝对路径）
 * - 每个 `/` 分段不能是 `.` 或 `..`（拒绝路径穿越）
 * - 每个分段仅含 [A-Za-z0-9._+-]
 *
 * 非法抛 Error。
 */
export function validateWorktreeSlug(slug: string): string {
  if (!slug) {
    throw new Error("Worktree slug must not be empty");
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `Worktree slug must be ${MAX_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    );
  }
  if (slug.startsWith("/") || slug.startsWith("\\")) {
    throw new Error(`Worktree slug must not be an absolute path: ${JSON.stringify(slug)}`);
  }
  for (const segment of slug.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(
        `Worktree slug ${JSON.stringify(slug)}: must not contain "." or ".." path segments`,
      );
    }
    if (!VALID_SEGMENT.test(segment)) {
      throw new Error(
        `Worktree slug ${JSON.stringify(slug)}: each segment must be non-empty and contain only ` +
          "letters, digits, dots, underscores, plus, and dashes",
      );
    }
  }
  return slug;
}

/** `/` → `+`，让 worktree 目录与分支名保持扁平。 */
function flattenSlug(slug: string): string {
  return slug.replace(/\//g, "+");
}

function worktreeBranch(slug: string): string {
  return `worktree-${flattenSlug(slug)}`;
}

// ---------------------------------------------------------------------------
// WorktreeManager
// ---------------------------------------------------------------------------

/**
 * 为隔离的 teammate 管理 git worktree。
 *
 * worktree 存放在 `baseDir/<flatSlug>`，分支名 `worktree-<flatSlug>`。
 * 通过注入的 GitRunner 跑命令，便于测试。
 */
export class WorktreeManager {
  private readonly runGit: GitRunner;
  readonly baseDir: string;
  readonly repoRoot: string;

  constructor(options: WorktreeManagerOptions) {
    this.runGit = options.runGit;
    this.baseDir = options.baseDir;
    this.repoRoot = options.repoRoot;
  }

  /** 计算 slug 对应的 worktree 绝对路径。 */
  pathFor(slug: string): string {
    return join(this.baseDir, flattenSlug(validateWorktreeSlug(slug)));
  }

  /** 计算 slug 对应的分支名。 */
  branchFor(slug: string): string {
    return worktreeBranch(validateWorktreeSlug(slug));
  }

  /** repoRoot 是否在 git 工作树内。 */
  async isGitRepo(): Promise<boolean> {
    const { code, stdout } = await this.runGit(
      ["rev-parse", "--is-inside-work-tree"],
      this.repoRoot,
    );
    return code === 0 && stdout.trim() === "true";
  }

  /**
   * 为 *slug* 创建（或复用）一个 worktree。
   *
   * 若 path 已是一个有效 worktree（出现在 `git worktree list` 里）→ 复用，created:false。
   * 否则 `git worktree add -B <branch> <path>`（基于 repoRoot 的当前 HEAD），created:true。
   * 失败抛 Error（含 git stderr）。
   */
  async create(slug: string): Promise<WorktreeCreateResult> {
    validateWorktreeSlug(slug);
    const flat = flattenSlug(slug);
    const path = join(this.baseDir, flat);
    const branch = worktreeBranch(slug);

    // 复用：path 已经是已注册的有效 worktree。
    const existing = await this.list();
    if (existing.some((w) => samePath(w.path, path))) {
      return { slug, path, branch, created: false };
    }

    // TODO: symlink node_modules / .venv 等大目录省空间（D.3 后续）。
    // -B（非 -b）：复位残留的同名孤儿分支。remove() 非 force 只删工作目录、保留
    // worktree-<slug> 分支；同一 slug 再 create 时 -b 会撞已存在分支而失败，-B 直接复位。
    // 对齐 Python worktree.py。
    const { code, stderr } = await this.runGit(
      ["worktree", "add", "-B", branch, path, "HEAD"],
      this.repoRoot,
    );
    if (code !== 0) {
      throw new Error(`git worktree add failed: ${stderr.trim()}`);
    }
    return { slug, path, branch, created: true };
  }

  /**
   * 按 slug 移除 worktree：`git worktree remove [--force] <path>`（在 repoRoot 跑）。
   *
   * 非 force 时若 worktree 有未提交改动，git 会以非零退出拒绝 → 这里转成抛 Error，
   * 调用方可据此判断「有改动、已保留」。
   */
  async remove(slug: string, opts?: { force?: boolean }): Promise<void> {
    validateWorktreeSlug(slug);
    const path = join(this.baseDir, flattenSlug(slug));
    const args = ["worktree", "remove"];
    if (opts?.force) args.push("--force");
    args.push(path);
    const { code, stderr } = await this.runGit(args, this.repoRoot);
    if (code !== 0) {
      throw new Error(`git worktree remove failed: ${stderr.trim()}`);
    }
  }

  /** 解析 `git worktree list --porcelain`，返回已注册 worktree 列表。 */
  async list(): Promise<WorktreeListEntry[]> {
    const { code, stdout } = await this.runGit(
      ["worktree", "list", "--porcelain"],
      this.repoRoot,
    );
    if (code !== 0) return [];
    return parseWorktreePorcelain(stdout, this.baseDir);
  }

  /** worktree 是否有未提交改动（`git status --porcelain` 在 worktree path 跑）。 */
  async hasChanges(slug: string): Promise<boolean> {
    validateWorktreeSlug(slug);
    const path = join(this.baseDir, flattenSlug(slug));
    const { code, stdout } = await this.runGit(["status", "--porcelain"], path);
    if (code !== 0) return false;
    return stdout.trim().length > 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 跨平台路径比较：归一化分隔符 + Windows 下大小写不敏感。 */
function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/**
 * 解析 `git worktree list --porcelain` 输出。
 *
 * 每条记录以 `worktree <path>` 开头，后跟 `HEAD <sha>`、`branch refs/heads/<name>` 等行，
 * 记录间以空行分隔。slug 由位于 baseDir 下的路径反推（去掉 baseDir 前缀 + `+` 还原 `/`）。
 */
function parseWorktreePorcelain(stdout: string, baseDir: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  const baseNorm = normalizePath(baseDir);

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      const path = line.slice("worktree ".length).trim();
      current = { path };
      const pathNorm = normalizePath(path);
      if (pathNorm.startsWith(baseNorm + "/")) {
        const flat = pathNorm.slice(baseNorm.length + 1);
        current.slug = flat.replace(/\+/g, "/");
      }
    } else if (current && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return entries;
}
