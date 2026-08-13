import { cancelPersistentWorkflow, WorkflowRunStore, type WorkflowRunEvent } from "@openharness/coordinator";
import type { SessionStore } from "@openharness/services";

import {
  DAEMON_RESTART_WORKFLOW_REASON,
  workflowRunIdFromSessionEvent,
} from "../support.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";

export interface WorkflowRecoveryContext {
  store: Pick<SessionStore, "appendEvent" | "getSession" | "listEvents">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
}

/**
 * Session runs and TaskManager ownership die with the daemon process. Workflow
 * snapshots are project-local, so reconcile only run ids that this session log
 * proves were started by this daemon; unrelated CLI/project workflows are left alone.
 */
export async function recoverInterruptedWorkflows(context: WorkflowRecoveryContext): Promise<void> {
  const ownedRuns = new Map<string, { sessionId: string; cwd: string }>();
  for (const event of context.store.listEvents()) {
    if (event.type !== "workflow.workflow_started" || !event.sessionId) continue;
    const runId = workflowRunIdFromSessionEvent(event);
    if (!runId) continue;
    const session = context.store.getSession(event.sessionId);
    if (session) ownedRuns.set(runId, { sessionId: session.id, cwd: session.cwd });
  }

  for (const [runId, owner] of ownedRuns) {
    const workflowStore = new WorkflowRunStore({ cwd: owner.cwd });
    let snapshot;
    try {
      snapshot = workflowStore.load(runId);
    } catch (error) {
      appendWorkflowRecoveryFailure(context, owner.sessionId, runId, error);
      continue;
    }
    if (!snapshot || snapshot.status !== "running") continue;

    const before = context.events.checkpoint();
    await cancelPersistentWorkflow(snapshot, {
      store: workflowStore,
      reason: DAEMON_RESTART_WORKFLOW_REASON,
      onEvent: (event: WorkflowRunEvent) => appendWorkflowRecoveryEvent(context, owner.sessionId, event),
    });
    context.events.publishSince(before);
  }
}

function appendWorkflowRecoveryEvent(
  context: WorkflowRecoveryContext,
  sessionId: string,
  event: WorkflowRunEvent,
): void {
  context.store.appendEvent({
    type: `workflow.${event.type}`,
    sessionId,
    payload: { event, recoveredAfterDaemonRestart: true },
  });
}

function appendWorkflowRecoveryFailure(
  context: WorkflowRecoveryContext,
  sessionId: string,
  runId: string,
  error: unknown,
): void {
  context.store.appendEvent({
    type: "workflow.workflow_recovery_failed",
    sessionId,
    payload: {
      runId,
      error: error instanceof Error ? error.message : String(error),
      recoveredAfterDaemonRestart: true,
    },
  });
}
