import type { SwarmBackend, SpawnResult, TeammateSpawnConfig, TeammateMessage } from "./index.js";

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
  /** agentId(`name@team`) -> taskId 映射，用于 terminate。 */
  private readonly agentTasks = new Map<string, string>();

  constructor(options: SubprocessBackendOptions) {
    this.taskRunner = options.taskRunner;
    this.buildCommand = options.buildCommand;
  }

  async spawn(config: TeammateSpawnConfig): Promise<SpawnResult> {
    const agentId = `${config.name}@${config.team}`;
    try {
      const { argv, env } = this.buildCommand(config);
      const task = await this.taskRunner.createShellTask({
        argv,
        description: `${config.name}@${config.team}`,
        cwd: config.cwd,
        env,
      });
      this.agentTasks.set(agentId, task.id);
      return {
        success: true,
        agentId,
        taskId: task.id,
        backendType: this.backendType,
      };
    } catch (err) {
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
  }

  /** 返回 agentId 对应的 taskId（用于调试/外部查询）。 */
  getTaskId(agentId: string): string | undefined {
    return this.agentTasks.get(agentId);
  }
}
