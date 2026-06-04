import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { getTasksDir } from "@openharness/core";

export type TaskType = "shell" | "agent";
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "stopped";

export interface TaskInfo {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  cwd: string;
  command?: string;
  /** Direct-exec argv (bypasses shell). Mutually exclusive with `command`. */
  argv?: string[];
  prompt?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  /** Extra env vars merged on top of process.env at spawn time. */
  env?: Record<string, string>;
  /** Absolute path to the task's output log file. */
  outputFile?: string;
  /** Mutable coordination/UI metadata (progress, status notes, restart_count, ...). */
  metadata: Record<string, string>;
}

/** Fired whenever a task reaches a terminal state (completed/failed/stopped). */
export type CompletionListener = (task: TaskInfo) => void | Promise<void>;

export interface CreateShellTaskOptions {
  command?: string;
  argv?: string[];
  description: string;
  cwd: string;
  type?: TaskType;
  env?: Record<string, string>;
}

export interface CreateAgentTaskOptions {
  prompt: string;
  description: string;
  cwd: string;
  type?: TaskType;
  model?: string;
  command?: string;
  argv?: string[];
  env?: Record<string, string>;
}

const MAX_OUTPUT_BYTES = 12_000;
const STOP_GRACE_MS = 3_000;
const MAX_RESTARTS = 5;
const RESTART_NOTICE =
  "[OpenHarness] Agent task restarted; prior interactive context was not preserved.\n";

interface RunState {
  child: ChildProcess;
  /** Monotonically increasing per restart; stale watchers ignore terminal updates. */
  generation: number;
}

/**
 * Manage shell and agent subprocess tasks with streaming output, stdin writes,
 * completion listeners, automatic agent restart, and graceful shutdown.
 *
 * Mirrors the Python `BackgroundTaskManager` (openharness v0.1.9). Public
 * positional methods (`createShellTask`/`createAgentTask`/...) stay
 * backward-compatible with existing TS callers; richer behaviour is exposed
 * through the options-object overloads.
 */
export class TaskManager {
  private tasks = new Map<string, TaskInfo>();
  private states = new Map<string, RunState>();
  private generations = new Map<string, number>();
  private writeChains = new Map<string, Promise<void>>();
  private completionListeners = new Map<string, CompletionListener>();
  private idCounter = 0;
  private readonly tasksDir: string;

  constructor(tasksDir?: string) {
    // Lazily fall back to a temp dir if core paths are unavailable; callers in
    // tests pass an explicit dir.
    this.tasksDir = tasksDir ?? defaultTasksDir();
  }

  // ── creation ────────────────────────────────────────────

  /**
   * Start a background shell task.
   *
   * Backward-compatible positional form: `createShellTask(command, description, cwd)`.
   * Options form supports `argv` (direct-exec, no shell) and `env`.
   */
  async createShellTask(command: string, description: string, cwd: string): Promise<TaskInfo>;
  async createShellTask(options: CreateShellTaskOptions): Promise<TaskInfo>;
  async createShellTask(
    commandOrOptions: string | CreateShellTaskOptions,
    description?: string,
    cwd?: string,
  ): Promise<TaskInfo> {
    const opts: CreateShellTaskOptions =
      typeof commandOrOptions === "string"
        ? { command: commandOrOptions, description: description!, cwd: cwd! }
        : commandOrOptions;

    if (opts.command == null && opts.argv == null) {
      throw new Error("createShellTask requires either command or argv");
    }
    if (opts.command != null && opts.argv != null) {
      throw new Error("createShellTask accepts only one of command or argv");
    }

    const id = `task_${++this.idCounter}`;
    const outputFile = join(this.tasksDir, `${id}.log`);
    const task: TaskInfo = {
      id,
      type: opts.type ?? "shell",
      status: "running",
      description: opts.description,
      cwd: opts.cwd,
      command: opts.command,
      argv: opts.argv ? [...opts.argv] : undefined,
      env: opts.env ? { ...opts.env } : undefined,
      outputFile,
      createdAt: Date.now(),
      startedAt: Date.now(),
      metadata: {},
    };
    this.ensureTasksDir();
    writeFileSync(outputFile, "");
    this.tasks.set(id, task);
    this.startProcess(id);
    return task;
  }

  /**
   * Start a local agent task as a subprocess.
   *
   * Backward-compatible positional form: `createAgentTask(prompt, description, cwd, model?)`.
   *
   * The agent's concrete command is the swarm's responsibility (Phase D): this
   * manager only spawns whatever `argv`/`command` it is handed and wires it
   * into the same execution/output/stop machinery. When neither `argv` nor
   * `command` is supplied the task is NOT silently left pending — it is marked
   * `failed` with `metadata.needs_argv = "1"` and a clear log line, so callers
   * (and the eventual swarm dispatcher) get an explicit, observable signal.
   */
  async createAgentTask(
    prompt: string,
    description: string,
    cwd: string,
    model?: string,
  ): Promise<TaskInfo>;
  async createAgentTask(options: CreateAgentTaskOptions): Promise<TaskInfo>;
  async createAgentTask(
    promptOrOptions: string | CreateAgentTaskOptions,
    description?: string,
    cwd?: string,
    model?: string,
  ): Promise<TaskInfo> {
    const opts: CreateAgentTaskOptions =
      typeof promptOrOptions === "string"
        ? { prompt: promptOrOptions, description: description!, cwd: cwd!, model }
        : promptOrOptions;

    // No concrete command yet (swarm dispatch is Phase D). Don't spawn — but
    // don't go silently pending either: register an explicit failed record.
    if (opts.command == null && opts.argv == null) {
      const id = `task_${++this.idCounter}`;
      const outputFile = join(this.tasksDir, `${id}.log`);
      this.ensureTasksDir();
      const message =
        "Agent task requires argv or command to spawn a subprocess " +
        "(swarm dispatch is not wired yet — Phase D).\n";
      writeFileSync(outputFile, message);
      const task: TaskInfo = {
        id,
        type: opts.type ?? "agent",
        status: "failed",
        description: opts.description,
        cwd: opts.cwd,
        prompt: opts.prompt,
        outputFile,
        createdAt: Date.now(),
        finishedAt: Date.now(),
        metadata: { needs_argv: "1", status_note: "Missing argv/command for agent task" },
      };
      this.tasks.set(id, task);
      await this.notifyCompletion(task);
      return task;
    }

    const task = await this.createShellTask({
      command: opts.command,
      argv: opts.argv,
      description: opts.description,
      cwd: opts.cwd,
      type: opts.type ?? "agent",
      env: opts.env,
    });
    task.prompt = opts.prompt;
    // Forward the prompt to the freshly spawned agent over stdin.
    await this.writeToTask(task.id, opts.prompt);
    return task;
  }

  // ── queries ─────────────────────────────────────────────

  getTask(taskId: string): TaskInfo | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(status?: string): TaskInfo[] {
    const all = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    if (status) return all.filter((t) => t.status === status);
    return all;
  }

  /** Return the tail of a task's output log. */
  readTaskOutput(taskId: string, maxBytes = MAX_OUTPUT_BYTES): string {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    let content = "";
    if (task.outputFile && existsSync(task.outputFile)) {
      content = readFileSync(task.outputFile, "utf-8");
    }
    if (content.length > maxBytes) content = content.slice(-maxBytes);
    return content || "(no output)";
  }

  // ── stdin ───────────────────────────────────────────────

  /**
   * Write one frame to a task's stdin. Plain text is sent line-framed; payloads
   * that contain embedded newlines are wrapped as a single JSON `{text}` line so
   * a readline-based worker protocol can consume them atomically.
   */
  async writeToTask(taskId: string, data: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const payload = encodeWorkerPayload(data);

    // Serialize writes per task so frames never interleave.
    const prev = this.writeChains.get(taskId) ?? Promise.resolve();
    const next = prev.then(() => this.doWrite(task, payload));
    this.writeChains.set(
      taskId,
      next.catch(() => {}),
    );
    return next;
  }

  private async doWrite(task: TaskInfo, payload: string): Promise<void> {
    let state = this.states.get(task.id);
    const writable = state?.child.stdin && !state.child.stdin.destroyed && state.child.exitCode === null;
    if (!writable) {
      if (task.type !== "agent") {
        throw new Error(`Task ${task.id} does not accept input`);
      }
      // Lazily resurrect the dead agent before writing (restart limit enforced
      // inside restartAgentTask).
      state = await this.restartAgentTask(task);
    }
    const stdin = state!.child.stdin!;
    try {
      await writeToStdin(stdin, payload);
    } catch (err) {
      // Broken pipe mid-write: restart the agent once and retry (still bounded
      // by the restart limit). Non-agent tasks just propagate the error.
      if (task.type !== "agent") throw err;
      const restarted = await this.restartAgentTask(task);
      await writeToStdin(restarted.child.stdin!, payload);
    }
  }

  // ── stop / shutdown ─────────────────────────────────────

  /** Terminate a running task: SIGTERM, then SIGKILL after a grace period. */
  async stopTask(taskId: string): Promise<TaskInfo> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const state = this.states.get(taskId);
    if (!state) {
      if (task.status === "completed" || task.status === "failed" || task.status === "stopped") {
        return task;
      }
      throw new Error(`Task ${taskId} is not running`);
    }

    // Mark stopped first so the exit watcher does not overwrite the status.
    task.status = "stopped";
    task.finishedAt = Date.now();
    // Bump generation so the watcher ignores this child's exit transition.
    this.generations.set(taskId, (this.generations.get(taskId) ?? 0) + 1);

    await terminateProcess(state.child, STOP_GRACE_MS);
    this.states.delete(taskId);
    await this.notifyCompletion(task);
    return task;
  }

  /** Register a completion listener; returns an unregister callback. */
  registerCompletionListener(listener: CompletionListener): () => void {
    const id = `listener_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    this.completionListeners.set(id, listener);
    return () => {
      this.completionListeners.delete(id);
    };
  }

  /** Best-effort synchronous cleanup of all tracked subprocesses. */
  close(): void {
    for (const [id, state] of this.states) {
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
      try {
        state.child.stdin?.end();
      } catch {
        /* ignore */
      }
      try {
        killProcessTree(state.child);
      } catch {
        /* ignore */
      }
    }
    this.states.clear();
  }

  /** Async graceful shutdown: SIGTERM all, await exit (KILL on timeout). */
  async aclose(): Promise<void> {
    const states = [...this.states.values()];
    for (const id of this.states.keys()) {
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    }
    await Promise.all(states.map((s) => terminateProcess(s.child, STOP_GRACE_MS)));
    this.states.clear();
  }

  // ── internals ───────────────────────────────────────────

  private ensureTasksDir(): void {
    if (!existsSync(this.tasksDir)) {
      mkdirSync(this.tasksDir, { recursive: true });
    }
  }

  private startProcess(taskId: string): RunState {
    const task = this.tasks.get(taskId)!;
    if (task.command == null && task.argv == null) {
      throw new Error(`Task ${taskId} does not have a command or argv to run`);
    }
    const generation = (this.generations.get(taskId) ?? 0) + 1;
    this.generations.set(taskId, generation);

    const env = task.env ? { ...process.env, ...task.env } : process.env;

    // On POSIX, run each task in its own process group (detached) so that, on
    // stop, we can signal the whole tree (the shell plus any grandchildren it
    // spawned) via `process.kill(-pid)`. Without this, a `shell: true` task's
    // grandchildren survive a `child.kill()` and leak. Windows uses
    // `taskkill /T` instead (see killProcessTree).
    const detached = process.platform !== "win32";

    let child: ChildProcess;
    if (task.argv != null) {
      const [cmd, ...args] = task.argv;
      child = spawn(cmd!, args, {
        cwd: task.cwd,
        env,
        detached,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      child = spawn(task.command!, {
        cwd: task.cwd,
        env,
        shell: true,
        detached,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    const append = (chunk: Buffer | string) => {
      try {
        if (task.outputFile) appendFileSync(task.outputFile, chunk);
      } catch {
        /* output file may be gone after shutdown */
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const state: RunState = { child, generation };
    this.states.set(taskId, state);

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      void this.handleExit(taskId, generation, code, signal);
    };
    child.on("exit", onExit);
    child.on("error", (err) => {
      append(`[spawn error] ${(err as Error).message}\n`);
      void this.handleExit(taskId, generation, 1, null);
    });

    return state;
  }

  private async handleExit(
    taskId: string,
    generation: number,
    code: number | null,
    _signal: NodeJS.Signals | null,
  ): Promise<void> {
    // Stale watcher (task was restarted or explicitly stopped).
    if (this.generations.get(taskId) !== generation) return;
    const task = this.tasks.get(taskId);
    if (!task) return;

    const exitCode = code ?? 1;

    // Process exit only records terminal state. Unlike a naive "restart on any
    // non-zero exit" loop, this mirrors Python's `_watch_process`: a dead
    // process is just marked completed/failed and never proactively restarted.
    // Agent tasks are resurrected lazily, only when something tries to write to
    // a dead agent's stdin (see `doWrite` -> `restartAgentTask`).
    task.exitCode = exitCode;
    if (task.status !== "stopped") {
      task.status = exitCode === 0 ? "completed" : "failed";
    }
    task.finishedAt = Date.now();
    this.states.delete(taskId);
    await this.notifyCompletion(task);
  }

  /**
   * Restart a dead agent task on demand (e.g. a write hit a broken pipe).
   *
   * This is the single chokepoint for the restart limit — every restart path
   * funnels through here, so it can never exceed `MAX_RESTARTS`. Before
   * spawning the replacement it reaps any lingering old child (mirroring
   * Python's `_restart_agent_task`, which awaits the prior waiter), so we never
   * leak an un-reaped subprocess.
   */
  private async restartAgentTask(task: TaskInfo): Promise<RunState> {
    if (task.command == null && task.argv == null) {
      throw new Error(`Task ${task.id} does not have a restart command or argv`);
    }
    const restartCount = parseInt(task.metadata.restart_count ?? "0", 10) + 1;
    if (restartCount > MAX_RESTARTS) {
      task.metadata.status_note = `Agent task restart limit (${MAX_RESTARTS}) reached.`;
      throw new Error(`Task ${task.id} exceeded restart limit (${MAX_RESTARTS})`);
    }

    // Reap any still-tracked previous child before spawning a replacement so we
    // never leave an orphaned subprocess behind.
    const prev = this.states.get(task.id);
    if (prev) {
      // Bump generation so the old child's exit watcher does not clobber state.
      this.generations.set(task.id, (this.generations.get(task.id) ?? 0) + 1);
      this.states.delete(task.id);
      await terminateProcess(prev.child, STOP_GRACE_MS);
    }

    task.metadata.restart_count = String(restartCount);
    task.metadata.status_note = "Task restarted; prior interactive context was not preserved.";
    task.status = "running";
    task.startedAt = Date.now();
    task.finishedAt = undefined;
    task.exitCode = undefined;
    if (task.outputFile) {
      try {
        appendFileSync(task.outputFile, RESTART_NOTICE);
      } catch {
        /* ignore */
      }
    }
    return this.startProcess(task.id);
  }

  private async notifyCompletion(task: TaskInfo): Promise<void> {
    const snapshot: TaskInfo = { ...task, metadata: { ...task.metadata } };
    for (const listener of [...this.completionListeners.values()]) {
      try {
        await listener(snapshot);
      } catch {
        /* a failing listener must not break others */
      }
    }
  }
}

// ── helpers ───────────────────────────────────────────────

function defaultTasksDir(): string {
  try {
    return getTasksDir();
  } catch {
    return join(process.cwd(), ".openharness", "tasks");
  }
}

/** Write a frame to stdin, resolving on flush or rejecting on a pipe error. */
function writeToStdin(stdin: NodeJS.WritableStream, payload: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stdin.write(payload, (err) => (err ? reject(err) : resolve()));
  });
}

/** Serialize one worker input as a single newline-terminated frame. */
function encodeWorkerPayload(data: string): string {
  const stripped = data.replace(/\n+$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
    return stripped + "\n";
  }
  if (!stripped.includes("\n") && !stripped.includes("\r")) {
    return stripped + "\n";
  }
  return JSON.stringify({ text: stripped }) + "\n";
}

/** SIGTERM, then SIGKILL after `graceMs`. Resolves when the child has exited. */
function terminateProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    if (process.platform === "win32") {
      // Windows has no real SIGTERM for console apps; kill the whole tree.
      killProcessTree(child);
    } else if (child.pid != null) {
      // Graceful SIGTERM to the whole process group (the child leads its own
      // group via `detached`), so shell-spawned grandchildren get a chance to
      // exit cleanly. Fall back to the single child if the group send fails.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }
    const timer = setTimeout(() => {
      try {
        killProcessTree(child);
      } catch {
        /* ignore */
      }
      // Give the OS a beat to report the exit.
      setTimeout(finish, 200);
    }, graceMs);
    if (child.exitCode !== null) finish();
  });
}

/** Force-kill a process and its children, cross-platform. */
function killProcessTree(child: ChildProcess): void {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    // taskkill /T kills the whole tree, /F forces it.
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  } else {
    // The child was spawned `detached`, so it leads its own process group whose
    // gid equals its pid. Signalling the negative pid kills the whole group —
    // the shell plus any grandchildren it forked. Fall back to a single-process
    // kill if the group send fails (e.g. the group is already gone).
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}

let _default: TaskManager | undefined;

export function getTaskManager(): TaskManager {
  if (!_default) _default = new TaskManager();
  return _default;
}

export function resetTaskManager(): void {
  if (_default) _default.close();
  _default = undefined;
}
