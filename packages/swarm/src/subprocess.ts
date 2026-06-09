import type { SwarmBackend, SpawnResult, TeammateSpawnConfig, TeammateMessage } from "./index.js";
import type { WorktreeManager } from "./worktree.js";

/**
 * 结构化的任务运行器接口。
 *
 * swarm 包不直接依赖 services 包，而是通过这个最小接口与 TaskManager 解耦。
 * 真实实现由调用方（apps/cli）注入 `getTaskManager()`，测试可注入 mock。
 */
export interface TaskRunner {
  createShellTask(opts: {
    argv?: string[];
    command?: string;
    description: string;
    cwd: string;
    env?: Record<string, string>;
    /** Optional task type marker (e.g. "agent" for teammate tasks). */
    type?: string;
  }): Promise<{ id: string }>;
  stopTask(id: string): Promise<void>;
}

export interface SubprocessBackendOptions {
  taskRunner: TaskRunner;
  /**
   * 把一个 teammate spawn 配置翻译成具体的子进程 argv（与可选 env）。
   *
   * 实现放在 apps/cli（buildTeammateCommand），因为只有那里知道 CLI 入口路径、
   * settings、权限继承等细节。这样 swarm 包保持纯粹、可单测。
   */
  buildCommand: (config: TeammateSpawnConfig) => { argv: string[]; env?: Record<string, string> };
  /**
   * 可选的 worktree 管理器。提供时 `config.isolate === true` 的 teammate 会在独立 worktree 里跑；
   * 缺省（或仓库非 git）时 isolate 退化为 no-op + 警告，不报错。
   */
  worktreeManager?: WorktreeManager;
}

/**
 * 最小可用的 subprocess swarm 后端。
 *
 * 每个 teammate 被拉起为一个独立子进程（通过 TaskRunner.createShellTask），
 * 复刻自 Python 的 SubprocessBackend，但 TS 端没有 `--task-worker` 长驻模式，
 * 改用 `--print` 一次性模式（见 apps/cli/src/teammate.ts）。因此当前是 one-shot：
 * teammate 跑完 prompt 即退出，多轮 sendMessage 留待后续 worker 后端。
 */
export class SubprocessBackend implements SwarmBackend {
  readonly backendType = "subprocess";
  private readonly taskRunner: TaskRunner;
  private readonly buildCommand: SubprocessBackendOptions["buildCommand"];
  private readonly worktreeManager?: WorktreeManager;
  /** agentId(`name@team`) -> taskId 映射，用于 terminate。 */
  private readonly agentTasks = new Map<string, string>();
  /** agentId -> 隔离信息（仅隔离的 teammate 有），用于 terminate 时清理 worktree。 */
  private readonly agentWorktrees = new Map<string, { slug: string; path: string }>();

  constructor(options: SubprocessBackendOptions) {
    this.taskRunner = options.taskRunner;
    this.buildCommand = options.buildCommand;
    this.worktreeManager = options.worktreeManager;
  }

  async spawn(config: TeammateSpawnConfig): Promise<SpawnResult> {
    const agentId = `${config.name}@${config.team}`;
    // 在 try 外声明：catch 需据此清理「已建但未登记」的孤儿 worktree。
    let isolateSlug: string | undefined;
    try {
      let cwd = config.cwd;
      let worktree: { path: string; branch: string } | undefined;
      let notice: string | undefined;

      if (config.isolate === true) {
        if (this.worktreeManager == null || !(await this.worktreeManager.isGitRepo())) {
          // 退化：无 worktree 管理器或非 git 仓库 → 用共享 cwd，仅带警告，不报错。
          notice =
            "isolate requested but unavailable (no worktree manager or not a git repo); running in shared cwd";
        } else {
          const slug = makeWorktreeSlug(config);
          const wt = await this.worktreeManager.create(slug);
          cwd = wt.path;
          worktree = { path: wt.path, branch: wt.branch };
          isolateSlug = slug;
        }
      }

      // buildCommand 拿到的 config 的 cwd 必须指向 worktree（若隔离）。
      const { argv, env } = this.buildCommand({ ...config, cwd });
      const task = await this.taskRunner.createShellTask({
        argv,
        description: agentId,
        cwd,
        env,
      });
      this.agentTasks.set(agentId, task.id);
      if (isolateSlug != null && worktree != null) {
        this.agentWorktrees.set(agentId, { slug: isolateSlug, path: worktree.path });
      }
      const result: SpawnResult = {
        success: true,
        agentId,
        taskId: task.id,
        backendType: this.backendType,
      };
      if (worktree != null) result.worktree = worktree;
      if (notice != null) result.notice = notice;
      return result;
    } catch (err) {
      // 若本次已建了隔离 worktree（拿到 slug）但后续 createShellTask 抛错，
      // 该 worktree 从未写进 agentWorktrees、terminate 永远清不到它 → 孤儿泄漏。
      // 尽力 force 清理（吞错），再返回失败。
      if (isolateSlug != null && this.worktreeManager != null) {
        try {
          await this.worktreeManager.remove(isolateSlug, { force: true });
        } catch {
          // 清理失败也别盖住原始错误。
        }
      }
      return {
        success: false,
        agentId,
        taskId: "",
        backendType: this.backendType,
        error: (err as Error).message,
      };
    }
  }

  async sendMessage(_agentId: string, _message: TeammateMessage): Promise<void> {
    throw new Error(
      "subprocess teammate is one-shot (--print); multi-turn messaging requires the worker backend — Phase D follow-up",
    );
  }

  async terminate(agentId: string): Promise<void> {
    const taskId = this.agentTasks.get(agentId);
    if (taskId == null) {
      throw new Error(`No active subprocess for agent ${agentId}`);
    }
    await this.taskRunner.stopTask(taskId);
    this.agentTasks.delete(agentId);

    // 隔离的 teammate：非 force 移除 worktree。有未提交改动时 git 拒绝 → remove 抛错，
    // 这里吞掉（保留 worktree+分支供 leader review），不让 terminate 失败。
    const wt = this.agentWorktrees.get(agentId);
    if (wt != null && this.worktreeManager != null) {
      try {
        await this.worktreeManager.remove(wt.slug);
      } catch {
        // worktree 有改动被拒：保留，等于「未改动才自动清」。
      }
      this.agentWorktrees.delete(agentId);
    }
  }

  /** 返回 agentId 对应的 taskId（用于调试/外部查询）。 */
  getTaskId(agentId: string): string | undefined {
    return this.agentTasks.get(agentId);
  }
}

/**
 * 为隔离的 teammate 生成唯一且合法的 worktree slug：`<team>-<name>-<shortId>`。
 *
 * 非安全字符（slug 仅允许 [A-Za-z0-9._+-]）替换为 `-`，shortId 用短随机串保证唯一。
 */
function makeWorktreeSlug(config: TeammateSpawnConfig): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  const shortId = Math.random().toString(36).slice(2, 8);
  return `${safe(config.team)}-${safe(config.name)}-${shortId}`;
}
