import { randomUUID } from "node:crypto";

import {
  createWorkflowRunSummary,
  decodeWorkflowRunEvent,
  decodeWorkflowRunSnapshot,
  type WorkflowRunEvent,
  type WorkflowRunRepository,
  type WorkflowRunSnapshot,
  type WorkflowRunSummary,
} from "@openharness/coordinator";
import type { SessionStore } from "@openharness/services";

/** daemon 使用的 Workflow repository。事实写进和 Session/Run 相同的 SQLite。 */
export class SessionWorkflowRunRepository implements WorkflowRunRepository {
  readonly repositoryKey: string;
  private readonly ownerId = `workflow-owner:${process.pid}:${randomUUID()}`;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly store: SessionStore,
    private readonly onDurableEvent?: (previousEventSeq: number) => void,
  ) {
    this.repositoryKey = `sqlite:${store.path}`;
  }

  save(snapshot: WorkflowRunSnapshot): void {
    this.store.saveWorkflowRun({
      runId: snapshot.runId,
      ownerSessionId: snapshot.ownerSession,
      ownerInputId: snapshot.ownerInput,
      ownerRunId: snapshot.ownerRun,
      status: snapshot.status,
      termination: snapshot.termination,
      snapshotJson: JSON.stringify(snapshot),
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      taskAttempts: Object.values(snapshot.results).map((result) => ({
        taskId: result.taskId,
        attempt: result.attempts,
        status: result.status,
        payloadJson: JSON.stringify(result),
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      })),
    });
    this.notify(snapshot.runId);
  }

  appendEvent(event: WorkflowRunEvent): void {
    const snapshot = this.load(event.runId);
    const previousEventSeq = this.store.latestEventSeq();
    this.store.appendWorkflowEvent({
      runId: event.runId,
      sessionId: snapshot?.ownerSession,
      type: event.type,
      eventJson: JSON.stringify(event),
      createdAt: event.timestamp,
    });
    this.onDurableEvent?.(previousEventSeq);
    this.notify(event.runId);
  }

  loadEvents(runId: string): WorkflowRunEvent[] {
    return this.store.listWorkflowEvents(runId).map(decodeWorkflowRunEvent);
  }

  load(runId: string): WorkflowRunSnapshot | undefined {
    const stored = this.store.loadWorkflowRun(runId);
    return stored ? decodeWorkflowRunSnapshot(stored.snapshotJson) : undefined;
  }

  list(): WorkflowRunSnapshot[] {
    return this.store.listWorkflowRuns().map((stored) => decodeWorkflowRunSnapshot(stored.snapshotJson));
  }

  listSummaries(): WorkflowRunSummary[] {
    return this.list().map(createWorkflowRunSummary);
  }

  latest(): WorkflowRunSnapshot | undefined {
    return this.list()[0];
  }

  claim(runId: string) {
    return this.store.claimWorkflowRun(runId, this.ownerId);
  }

  finish(runId: string, status: WorkflowRunSnapshot["status"]): void {
    this.store.finishWorkflowRunClaim(runId, this.ownerId, status);
  }

  async waitForChange(
    runId: string,
    after: number,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WorkflowRunSnapshot | undefined> {
    const current = this.load(runId);
    if (!current || current.updatedAt > after) return current;
    return await new Promise((resolve, reject) => {
      const listeners = this.listeners.get(runId) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        listeners.delete(changed);
        options.signal?.removeEventListener("abort", aborted);
        if (listeners.size === 0) this.listeners.delete(runId);
      };
      const changed = () => {
        finish();
        resolve(this.load(runId));
      };
      const aborted = () => {
        finish();
        reject(options.signal?.reason ?? new Error("Workflow wait aborted."));
      };
      listeners.add(changed);
      this.listeners.set(runId, listeners);
      if (options.signal?.aborted) {
        aborted();
        return;
      }
      options.signal?.addEventListener("abort", aborted, { once: true });
      const registered = this.load(runId);
      if (!registered || registered.updatedAt > after) {
        changed();
        return;
      }
      timer = setTimeout(() => {
        finish();
        resolve(this.load(runId));
      }, Math.max(1, options.timeoutMs));
      timer.unref?.();
    });
  }

  private notify(runId: string): void {
    for (const listener of [...(this.listeners.get(runId) ?? [])]) listener();
  }
}
