import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface TaskInfo {
  id: string;
  type: "shell" | "agent";
  status: "pending" | "running" | "completed" | "failed" | "stopped";
  description: string;
  cwd: string;
  command?: string;
  prompt?: string;
  createdAt: number;
  finishedAt?: number;
  exitCode?: number;
}

const MAX_OUTPUT_BYTES = 100_000;

export class TaskManager {
  private tasks = new Map<string, TaskInfo>();
  private outputs = new Map<string, string>();
  private processes = new Map<string, ReturnType<typeof exec>>();
  private idCounter = 0;

  async createShellTask(
    command: string,
    description: string,
    cwd: string
  ): Promise<TaskInfo> {
    const id = `task_${++this.idCounter}`;
    const task: TaskInfo = {
      id,
      type: "shell",
      status: "running",
      description,
      cwd,
      command,
      createdAt: Date.now(),
    };
    this.tasks.set(id, task);

    const child = exec(command, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join("\n");
      this.outputs.set(id, output.slice(-MAX_OUTPUT_BYTES));
      task.status = error ? "failed" : "completed";
      task.exitCode = error?.code ?? 0;
      task.finishedAt = Date.now();
      this.processes.delete(id);
    });
    this.processes.set(id, child);

    return task;
  }

  async createAgentTask(
    prompt: string,
    description: string,
    cwd: string,
    _model?: string
  ): Promise<TaskInfo> {
    const id = `task_${++this.idCounter}`;
    const task: TaskInfo = {
      id,
      type: "agent",
      status: "pending",
      description,
      cwd,
      prompt,
      createdAt: Date.now(),
    };
    this.tasks.set(id, task);
    return task;
  }

  getTask(taskId: string): TaskInfo | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(status?: string): TaskInfo[] {
    const all = [...this.tasks.values()];
    if (status) return all.filter((t) => t.status === status);
    return all;
  }

  readTaskOutput(taskId: string, maxBytes = 12000): string {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const output = this.outputs.get(taskId) ?? "";
    return output.slice(-maxBytes) || "(no output)";
  }

  async stopTask(taskId: string): Promise<TaskInfo> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const child = this.processes.get(taskId);
    if (child) {
      child.kill("SIGTERM");
      this.processes.delete(taskId);
    }
    task.status = "stopped";
    task.finishedAt = Date.now();
    return task;
  }

  async writeToTask(taskId: string, _message: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
  }
}

let _default: TaskManager | undefined;

export function getTaskManager(): TaskManager {
  if (!_default) _default = new TaskManager();
  return _default;
}
