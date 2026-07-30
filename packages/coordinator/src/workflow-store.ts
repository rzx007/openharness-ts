import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getProjectConfigDir } from "@openharness/core";
import {
  createWorkflowRunSummary,
  createWorkflowResultFromSnapshot,
  runWorkflow,
  type WorkflowRunEvent,
  type WorkflowRunSummary,
  type WorkflowRunSnapshot,
  type WorkflowRunner,
  type WorkflowRunResult,
  type WorkflowSpec,
} from "./workflow-scheduler.js";

export interface WorkflowRunStoreOptions {
  cwd?: string;
  dir?: string;
}

export interface RunPersistentWorkflowOptions extends WorkflowRunStoreOptions {
  runId?: string;
  store?: WorkflowRunStore;
  onEvent?: (event: WorkflowRunEvent) => void;
}

export interface ResumePersistentWorkflowOptions extends WorkflowRunStoreOptions {
  store?: WorkflowRunStore;
  onEvent?: (event: WorkflowRunEvent) => void;
}

export function getWorkflowRunsDir(cwd?: string): string {
  return join(getProjectConfigDir(cwd), "workflows");
}

export class WorkflowRunStore {
  readonly dir: string;

  constructor(options: WorkflowRunStoreOptions = {}) {
    this.dir = options.dir ?? getWorkflowRunsDir(options.cwd);
  }

  pathFor(runId: string): string {
    return join(this.dir, `${sanitizeRunId(runId)}.json`);
  }

  eventPathFor(runId: string): string {
    return join(this.dir, `${sanitizeRunId(runId)}.events.ndjson`);
  }

  save(snapshot: WorkflowRunSnapshot): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(this.pathFor(snapshot.runId), JSON.stringify(snapshot, null, 2) + "\n");
  }

  appendEvent(event: WorkflowRunEvent): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.eventPathFor(event.runId), JSON.stringify(event) + "\n", "utf-8");
  }

  loadEvents(runId: string): WorkflowRunEvent[] {
    const path = this.eventPathFor(runId);
    if (!existsSync(path)) return [];
    const events: WorkflowRunEvent[] = [];
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        const event = JSON.parse(line) as unknown;
        if (isWorkflowRunEvent(event)) events.push(event);
      } catch {
        // Ignore corrupt event lines so a partial append doesn't hide the usable timeline.
      }
    }
    return events;
  }

  load(runId: string): WorkflowRunSnapshot | undefined {
    const path = this.pathFor(runId);
    if (!existsSync(path)) return undefined;
    return parseWorkflowRunSnapshot(readFileSync(path, "utf-8"));
  }

  list(): WorkflowRunSnapshot[] {
    if (!existsSync(this.dir)) return [];
    const snapshots: WorkflowRunSnapshot[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const snapshot = parseWorkflowRunSnapshot(readFileSync(join(this.dir, entry.name), "utf-8"));
        snapshots.push(snapshot);
      } catch {
        // Ignore corrupt or partial files so one bad snapshot doesn't hide the rest.
      }
    }
    return snapshots.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listSummaries(): WorkflowRunSummary[] {
    return this.list().map(createWorkflowRunSummary);
  }

  latest(): WorkflowRunSnapshot | undefined {
    return this.list()[0];
  }

  async resume(runId: string, runner: WorkflowRunner): Promise<WorkflowRunResult> {
    const snapshot = this.load(runId);
    if (!snapshot) throw new Error(`Workflow run not found: ${runId}`);
    return resumePersistentWorkflow(snapshot, runner, { store: this });
  }

  async resumeLatest(runner: WorkflowRunner): Promise<WorkflowRunResult> {
    const snapshot = this.latest();
    if (!snapshot) throw new Error("No workflow runs found");
    return resumePersistentWorkflow(snapshot, runner, { store: this });
  }
}

export async function runPersistentWorkflow(
  spec: WorkflowSpec,
  runner: WorkflowRunner,
  options: RunPersistentWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  const store = options.store ?? new WorkflowRunStore({ cwd: options.cwd, dir: options.dir });
  return runWorkflow(spec, runner, {
    runId: options.runId,
    onSnapshot: (snapshot) => store.save(snapshot),
    onEvent: (event) => {
      store.appendEvent(event);
      options.onEvent?.(event);
    },
  });
}

export async function resumePersistentWorkflow(
  snapshotOrRunId: WorkflowRunSnapshot | string,
  runner: WorkflowRunner,
  options: ResumePersistentWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  const store = options.store ?? new WorkflowRunStore({ cwd: options.cwd, dir: options.dir });
  const snapshot =
    typeof snapshotOrRunId === "string"
      ? store.load(snapshotOrRunId)
      : snapshotOrRunId;
  if (!snapshot) {
    throw new Error(`Workflow run not found: ${snapshotOrRunId}`);
  }
  if (snapshot.status !== "running") {
    return createWorkflowResultFromSnapshot(snapshot);
  }
  return runWorkflow(snapshot.spec, runner, {
    runId: snapshot.runId,
    createdAt: snapshot.createdAt,
    initialResults: snapshot.results,
    initialRunningTasks: snapshot.runningTasks,
    onSnapshot: (next) => store.save(next),
    onEvent: (event) => {
      store.appendEvent(event);
      options.onEvent?.(event);
    },
  });
}

function sanitizeRunId(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`Invalid workflow run id '${runId}'`);
  }
  return runId;
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
}

function parseWorkflowRunSnapshot(text: string): WorkflowRunSnapshot {
  const value = JSON.parse(text) as unknown;
  if (!isWorkflowRunSnapshot(value)) {
    throw new Error("Invalid workflow run snapshot");
  }
  return {
    ...value,
    blockedTaskIds: value.blockedTaskIds ?? [],
    blockedTasks: value.blockedTasks ?? {},
    runningTasks: value.runningTasks ?? {},
    budget: value.budget ?? { tasks: {} },
  };
}

function isWorkflowRunSnapshot(value: unknown): value is WorkflowRunSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as WorkflowRunSnapshot;
  return (
    candidate.version === 1 &&
    typeof candidate.runId === "string" &&
    (candidate.status === "running" || candidate.status === "completed" || candidate.status === "failed") &&
    typeof candidate.summary === "string" &&
    typeof candidate.spec === "object" &&
    candidate.spec !== null &&
    typeof candidate.plan === "object" &&
    candidate.plan !== null &&
    typeof candidate.results === "object" &&
    candidate.results !== null &&
    Array.isArray(candidate.orderedResults) &&
    Array.isArray(candidate.pendingTaskIds) &&
    (candidate.blockedTaskIds === undefined || Array.isArray(candidate.blockedTaskIds)) &&
    (candidate.blockedTasks === undefined || (typeof candidate.blockedTasks === "object" && candidate.blockedTasks !== null)) &&
    Array.isArray(candidate.runningTaskIds) &&
    (candidate.runningTasks === undefined || (typeof candidate.runningTasks === "object" && candidate.runningTasks !== null)) &&
    (candidate.budget === undefined || (typeof candidate.budget === "object" && candidate.budget !== null)) &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number"
  );
}

function isWorkflowRunEvent(value: unknown): value is WorkflowRunEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as WorkflowRunEvent;
  return (
    candidate.version === 1 &&
    typeof candidate.runId === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.timestamp === "number"
  );
}
