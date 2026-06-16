import type { SwarmBackend, SpawnResult, TeammateSpawnConfig, TeammateMessage } from "./index.js";
import type { WorktreeManager } from "./worktree.js";

/**
 * 结构化的任务运行器接口。
 *
 * swarm 包不直接依赖 services 包，而是通过这个最小接口与 TaskManager 解耦。
 * 真实实现由调用方（apps/cli）注入 `getTaskManager()`，测试可注入 mock。
 */
export interface TaskRunner {
  /** 可选:历史遗留(teammate 已全走 createAgentTask),保留兼容旧注入方。 */
  createShellTask?(opts: {
    argv?: string[];
    command?: string;
    description: string;
    cwd: string;
    env?: Record<string, string>;
    type?: string;
  }): Promise<{ id: string }>;
  /** agent 任务:spawn 后把 prompt 经 stdin 喂给子进程(task-worker 多轮承载)。 */
  createAgentTask(opts: {
    prompt: string;
    argv?: string[];
    command?: string;
    description: string;
    cwd: string;
    env?: Record<string, string>;
    type?: string;
  }): Promise<{ id: string }>;
  /** 往任务 stdin 写一行;任务已结束时由实现方懒复活重启(多轮 sendMessage)。 */
  writeToTask(id: string, data: string): Promise<void>;
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
  /**
   * 可选的 teammate 登记钩子：spawn 成功后调用（如把成员写进 team.json）。
   * 钩子抛错会让 spawn 失败并清理已创建的任务，保持 agentTasks 与登记状态一致。
   * 注入而非内联，保持后端可单测。
   */
  registerTeammate?: (config: TeammateSpawnConfig, result: SpawnResult) => void;
}

/**
 * 最小可用的 subprocess swarm 后端。
 *
 * 每个 teammate 被拉起为一个独立子进程（TaskRunner.createAgentTask，prompt 经
 * stdin），跑 `--task-worker` 模式：读一行跑一轮即退（对齐 Python）。多轮 =
 * sendMessage 写 stdin 时 TaskManager 懒复活重启进程（重启不保留上下文）。
 */
export class SubprocessBackend implements SwarmBackend {
  readonly backendType = "subprocess";
  private readonly taskRunner: TaskRunner;
  private readonly buildCommand: SubprocessBackendOptions["buildCommand"];
  private readonly worktreeManager?: WorktreeManager;
  private readonly registerTeammate?: SubprocessBackendOptions["registerTeammate"];
  /** agentId(`name@team`) -> taskId 映射，用于 terminate。 */
  private readonly agentTasks = new Map<string, string>();
  /** agentId -> 隔离信息（仅隔离的 teammate 有），用于 terminate 时清理 worktree。 */
  private readonly agentWorktrees = new Map<string, { slug: string; path: string }>();

  constructor(options: SubprocessBackendOptions) {
    this.taskRunner = options.taskRunner;
    this.buildCommand = options.buildCommand;
    this.worktreeManager = options.worktreeManager;
    this.registerTeammate = options.registerTeammate;
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
      // createAgentTask:prompt 经 stdin(--task-worker 读一行跑一轮)。
      const task = await this.taskRunner.createAgentTask({
        prompt: config.prompt,
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
      if (this.registerTeammate) {
        // 若钩子抛错，让错误传播到 outer catch：此时 agentTasks 已有条目但登记未完成，
        // outer catch 负责清理，确保 agentTasks 与外部登记状态一致。
        this.registerTeammate({ ...config, cwd }, result);
      }
      return result;
    } catch (err) {
      // createAgentTask 成功后 registerTeammate 失败会到这里：agentTasks 已写入
      // 但进程登记不完整，需主动清理并停止孤儿任务。
      const orphanTaskId = this.agentTasks.get(agentId);
      if (orphanTaskId != null) {
        this.agentTasks.delete(agentId);
        this.agentWorktrees.delete(agentId);
        try {
          await this.taskRunner.stopTask(orphanTaskId);
        } catch {
          // stopTask 失败不应掩盖原始错误。
        }
      }
      // 若本次已建了隔离 worktree（拿到 slug）但后续步骤抛错，
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

  /**
   * 给 teammate 发后续消息:JSON 行写任务 stdin。任务已结束时 TaskManager
   * 懒复活重启进程再写入(重启不保留上下文,对齐 Python)。
   */
  async sendMessage(agentId: string, message: TeammateMessage): Promise<void> {
    const taskId = this.agentTasks.get(agentId);
    if (taskId == null) {
      throw new Error(`No active subprocess for agent ${agentId}`);
    }
    const payload: Record<string, unknown> = {
      text: message.text,
      from: message.fromAgent,
      timestamp: new Date().toISOString(),
    };
    await this.taskRunner.writeToTask(taskId, JSON.stringify(payload));
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
