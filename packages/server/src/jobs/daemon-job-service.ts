import {
  cancelPersistentWorkflow,
  WorkflowRunStore,
  type WorkflowRunSnapshot,
} from "@openharness/coordinator";
import {
  filterJobSnapshots,
  type AgentJobHost,
  type JobCancelRequest,
  type JobKind,
  type JobListRequest,
  type JobReadRequest,
  type JobReadResult,
  type JobSnapshot,
  type JobStatus,
  type JobWaitRequest,
  type JobWaitResult,
} from "@openharness/jobs";
import type { SessionRecord, SessionTaskRecord } from "@openharness/services/session-runtime/types";
import type { TerminalSessionInfo } from "@openharness/terminal";

import type { DaemonTerminalService } from "../terminal/index.js";

interface JobTaskProjection {
  list(input: { sessionId: string }): { tasks: unknown[] };
  stop(taskId: string, input: { sessionId: string }): Promise<{ task: unknown }>;
}

interface JobSessionStore {
  getSession(sessionId: string): SessionRecord | undefined;
  listSessionTasks(sessionId: string): SessionTaskRecord[];
  getSessionTask(taskId: string): SessionTaskRecord | undefined;
}

interface JobTaskManager {
  readTaskOutput(taskId: string): string;
  writeToTask(taskId: string, data: string): Promise<void>;
  stopTask(taskId: string): Promise<unknown>;
}

const POLL_INTERVAL_MS = 50;
const DEFAULT_OUTPUT_LIMIT = 12_000;

export class DaemonJobService {
  constructor(
    private readonly store: JobSessionStore,
    private readonly terminals: DaemonTerminalService,
    private readonly tasks: JobTaskProjection,
    private readonly getTaskManager: (scope: { cwd: string; sessionId: string }) => JobTaskManager,
  ) {}

  createAgentHost(session: SessionRecord): AgentJobHost {
    return {
      list: async (input) => await this.list(this.owned(session, input)),
      read: async (input) => await this.read(this.owned(session, input)),
      wait: async (input) => await this.wait(this.owned(session, input)),
      send: async (input) => await this.send(this.owned(session, input)),
      cancel: async (input) => await this.cancel(this.owned(session, input)),
    };
  }

  async list(input: JobListRequest): Promise<JobSnapshot[]> {
    const session = this.requireSession(input.sessionId);
    this.tasks.list({ sessionId: session.id });
    const terminals = await this.terminals.list({ sessionId: session.id, source: "agent" });
    const tasks = this.store.listSessionTasks(session.id);
    const workflows = new WorkflowRunStore({ cwd: session.cwd })
      .list()
      .filter((workflow) => workflow.ownerSession === session.id);
    return filterJobSnapshots([
      ...terminals.map(terminalSnapshot),
      ...tasks.map(taskSnapshot),
      ...workflows.map((workflow) => workflowSnapshot(workflow, session.cwd)),
    ], input);
  }

  async read(input: JobReadRequest): Promise<JobReadResult> {
    const source = await this.resolve(input.sessionId, input.jobId);
    if (source.kind === "terminal") {
      const output = await this.terminals.readRequest({
        terminalId: source.value.id,
        after: input.after,
        maxChars: normalizeLimit(input.maxChars),
      });
      return {
        text: output.data,
        cursor: output.sequence,
        truncated: output.truncated,
        snapshot: terminalSnapshot(await this.terminals.get(source.value.id)),
      };
    }
    if (source.kind === "task") {
      const snapshot = taskSnapshot(source.value);
      const text = input.after !== undefined && input.after >= snapshot.updatedAt
        ? ""
        : this.readTaskOutput(source.value);
      const limited = limitOutput(text, input.maxChars);
      return { ...limited, cursor: snapshot.updatedAt, snapshot };
    }
    const snapshot = workflowSnapshot(source.value, source.cwd);
    const text = input.after !== undefined && input.after >= snapshot.updatedAt
      ? ""
      : formatWorkflowOutput(source.value);
    const limited = limitOutput(text, input.maxChars);
    return {
      ...limited,
      cursor: snapshot.updatedAt,
      snapshot,
      details: workflowDetails(source.value),
    };
  }

  async wait(input: JobWaitRequest): Promise<JobWaitResult> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new Error("Job wait timeoutMs must be a positive finite number.");
    }
    const source = await this.resolve(input.sessionId, input.jobId);
    if (source.kind === "terminal") {
      const waited = await this.terminals.wait({
        terminalId: source.value.id,
        timeoutMs: input.timeoutMs,
        after: input.after,
        maxChars: normalizeLimit(input.maxChars),
        signal: input.signal,
      });
      return {
        text: waited.data,
        cursor: waited.sequence,
        truncated: waited.truncated,
        snapshot: terminalSnapshot(waited.terminal),
        timedOut: waited.timedOut,
      };
    }
    const initial = await this.read(input);
    if (isFinished(initial.snapshot.status)) return { ...initial, timedOut: false };
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), input.signal);
      const current = await this.read(input);
      if (isFinished(current.snapshot.status)) return { ...current, timedOut: false };
    }
    return { ...(await this.read(input)), timedOut: true };
  }

  async send(input: { sessionId: string; jobId: string; data: string }): Promise<void> {
    const source = await this.resolve(input.sessionId, input.jobId);
    if (source.kind === "terminal") {
      await this.terminals.write({ terminalId: source.value.id, data: input.data });
      return;
    }
    if (source.kind === "task") {
      if (!taskAcceptsInput(source.value)) {
        throw new Error(`Job ${input.jobId} does not accept input.`);
      }
      const manager = this.managerFor(input.sessionId);
      await manager.writeToTask(managerTaskId(source.value), input.data);
      return;
    }
    throw new Error(`Workflow ${input.jobId} does not accept input.`);
  }

  async cancel(input: JobCancelRequest): Promise<JobSnapshot> {
    const source = await this.resolve(input.sessionId, input.jobId);
    if (source.kind === "terminal") {
      await this.terminals.close(source.value.id);
      return terminalSnapshot(await this.terminals.get(source.value.id));
    }
    if (source.kind === "task") {
      await this.tasks.stop(source.value.id, { sessionId: input.sessionId });
      return taskSnapshot(this.store.getSessionTask(source.value.id) ?? source.value);
    }
    const session = this.requireSession(input.sessionId);
    const manager = this.managerFor(input.sessionId);
    const store = new WorkflowRunStore({ cwd: session.cwd });
    await cancelPersistentWorkflow(source.value, {
      store,
      reason: input.reason,
      stopTask: async (taskId) => await manager.stopTask(taskId),
    });
    return workflowSnapshot(store.load(source.value.runId)!, session.cwd);
  }

  private owned<T extends { sessionId: string }>(session: SessionRecord, input: T): T {
    if (input.sessionId !== session.id) throw new Error("Job owner session mismatch.");
    return input;
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  private managerFor(sessionId: string) {
    const session = this.requireSession(sessionId);
    return this.getTaskManager({ cwd: session.cwd, sessionId });
  }

  private readTaskOutput(task: SessionTaskRecord): string {
    try {
      return this.managerFor(task.sessionId).readTaskOutput(managerTaskId(task));
    } catch {
      return task.output ?? "";
    }
  }

  private async resolve(sessionId: string, jobId: string): Promise<
    | { kind: "terminal"; value: TerminalSessionInfo }
    | { kind: "task"; value: SessionTaskRecord }
    | { kind: "workflow"; value: WorkflowRunSnapshot; cwd: string }
  > {
    this.requireSession(sessionId);
    this.tasks.list({ sessionId });
    const terminal = (await this.terminals.list({ sessionId, source: "agent" }))
      .find((candidate) => candidate.id === jobId);
    if (terminal) return { kind: "terminal", value: terminal };
    const task = this.store.getSessionTask(jobId);
    if (task?.sessionId === sessionId) return { kind: "task", value: task };
    const session = this.requireSession(sessionId);
    const workflow = new WorkflowRunStore({ cwd: session.cwd }).load(jobId);
    if (workflow?.ownerSession === sessionId) return { kind: "workflow", value: workflow, cwd: session.cwd };
    throw new Error(`Job not found: ${jobId}`);
  }
}

function terminalSnapshot(terminal: TerminalSessionInfo): JobSnapshot {
  const updated = terminal.exitedAt ?? terminal.createdAt;
  return {
    id: terminal.id,
    kind: "terminal",
    label: terminal.name,
    ownerSession: terminal.sessionId!,
    status: terminal.status,
    capabilities: { read: true, wait: true, send: terminal.status === "running", cancel: terminal.status === "running" },
    cwd: terminal.cwd,
    startedAt: Date.parse(terminal.createdAt),
    updatedAt: Date.parse(updated),
    ...(terminal.exitedAt ? { finishedAt: Date.parse(terminal.exitedAt) } : {}),
    ...(terminal.exitCode !== undefined ? { detail: `exit code: ${terminal.exitCode ?? "signal"}` } : {}),
    metadata: { runtime: terminal.runtime, shell: terminal.shell, source: terminal.source },
  };
}

function taskSnapshot(task: SessionTaskRecord): JobSnapshot {
  return {
    id: task.id,
    kind: taskKind(task.type),
    label: task.description,
    ownerSession: task.sessionId,
    status: taskStatus(task.status),
    capabilities: {
      read: true,
      wait: true,
      send: taskAcceptsInput(task),
      cancel: task.status === "pending" || task.status === "running",
    },
    cwd: task.cwd,
    startedAt: task.startedAt ?? task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.error ? { detail: task.error } : {}),
    metadata: { ...task.metadata, ...(task.childSessionId ? { childSessionId: task.childSessionId } : {}) },
  };
}

function workflowSnapshot(workflow: WorkflowRunSnapshot, cwd: string): JobSnapshot {
  const cancelled = workflow.termination === "cancelled";
  return {
    id: workflow.runId,
    kind: "workflow",
    label: workflow.summary,
    ownerSession: workflow.ownerSession!,
    status: workflow.status === "running" ? "running" : cancelled ? "killed" : workflow.status,
    capabilities: { read: true, wait: true, send: false, cancel: workflow.status === "running" },
    cwd,
    startedAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    ...(workflow.status !== "running" ? { finishedAt: workflow.updatedAt } : {}),
    metadata: {
      mode: workflow.plan.mode,
      totalTasks: workflow.plan.tasks.length,
      runningTasks: workflow.runningTaskIds.length,
      pendingTasks: workflow.pendingTaskIds.length,
    },
  };
}

function taskKind(type: string): JobKind {
  return type === "shell" || type === "dream" ? type : "agent";
}

function taskStatus(status: SessionTaskRecord["status"]): JobStatus {
  if (status === "completed" || status === "failed") return status;
  if (status === "stopped" || status === "interrupted") return "killed";
  return "running";
}

function taskAcceptsInput(task: SessionTaskRecord): boolean {
  return task.type === "agent" && task.status !== "stopped" && task.status !== "interrupted";
}

function managerTaskId(task: SessionTaskRecord): string {
  return typeof task.metadata.taskManagerId === "string" ? task.metadata.taskManagerId : task.id;
}

function formatWorkflowOutput(workflow: WorkflowRunSnapshot): string {
  return JSON.stringify({
    summary: workflow.summary,
    status: workflow.status,
    pendingTaskIds: workflow.pendingTaskIds,
    runningTaskIds: workflow.runningTaskIds,
    results: workflow.orderedResults,
  }, null, 2);
}

function workflowDetails(workflow: WorkflowRunSnapshot): Record<string, unknown> {
  return {
    status: workflow.status,
    termination: workflow.termination,
    plan: workflow.plan,
    pendingTaskIds: workflow.pendingTaskIds,
    blockedTaskIds: workflow.blockedTaskIds,
    blockedTasks: workflow.blockedTasks,
    runningTaskIds: workflow.runningTaskIds,
    runningTasks: workflow.runningTasks,
    results: workflow.results,
    budget: workflow.budget,
  };
}

function normalizeLimit(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value)
    ? DEFAULT_OUTPUT_LIMIT
    : Math.max(1, Math.floor(value));
}

function limitOutput(text: string, maxChars = DEFAULT_OUTPUT_LIMIT): Pick<JobReadResult, "text" | "truncated"> {
  const limit = normalizeLimit(maxChars);
  return text.length > limit ? { text: text.slice(-limit), truncated: true } : { text, truncated: false };
}

function isFinished(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(1, ms));
    timer.unref?.();
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Job wait aborted."));
    }
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
