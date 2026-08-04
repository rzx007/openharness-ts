import { Hono } from "hono";

import type { SessionStore } from "@openharness/services";

import {
  errorResponse,
  isRecord,
  jsonResponse,
  readJson,
  sessionMutationErrorStatus,
} from "../support.js";
import type { SessionRunCoordinator } from "../../run-coordinator.js";

type AdmitPromptInput = {
  id?: string;
  delivery?: "queue" | "steer";
  content: string;
  metadata?: Record<string, unknown>;
  runMetadata?: Record<string, unknown>;
  traceId?: string;
};

type AdmitPromptResult = {
  input: ReturnType<SessionStore["admitPrompt"]>;
  run?: ReturnType<SessionStore["createRun"]>;
  queue_state?: "running" | "queued";
};

export interface RunExecutionRoutesContext {
  store: Pick<
    SessionStore,
    "appendEvent" | "findRunByInput" | "getInput" | "getRun" | "listInputs"
  >;
  hasRuntime(): boolean;
  hasRunWork(sessionId: string): boolean;
  latestEventSeq(): number;
  broadcastSince(seq: number): void;
  traceIdForRequest(request: Request): string;
  admitPromptAndMaybeRun(sessionId: string, input: AdmitPromptInput): AdmitPromptResult;
  interruptSession(sessionId: string): ReturnType<SessionRunCoordinator["interrupt"]>;
}

export function createRunExecutionRoutes(context: RunExecutionRoutesContext): Hono {
  return new Hono()
    .post("/:sessionId/prompts", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const body = await readJson(c);
      if (typeof body.content !== "string") return errorResponse(400, "content is required");

      try {
        const admitted = context.admitPromptAndMaybeRun(sessionId, {
          id: typeof body.id === "string" ? body.id : undefined,
          delivery: body.delivery === "steer" ? "steer" : "queue",
          content: body.content,
          metadata: isRecord(body.metadata) ? body.metadata : undefined,
          traceId: context.traceIdForRequest(c.req.raw),
        });
        return jsonResponse(admitted, 202);
      } catch (error) {
        return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
      }
    })
    .post("/:sessionId/runs/:runId/resume", async (c) => {
      const sessionId = c.req.param("sessionId");
      const runId = c.req.param("runId");
      if (!sessionId || !runId) return errorResponse(400, "sessionId and runId are required");
      const body = await readJson(c);
      if (body.id !== undefined && typeof body.id !== "string") return errorResponse(400, "id must be a string");
      if (body.metadata !== undefined && !isRecord(body.metadata)) return errorResponse(400, "metadata must be an object");

      const sourceRun = context.store.getRun(runId);
      if (!sourceRun || sourceRun.sessionId !== sessionId) return errorResponse(404, "Interrupted run not found");
      if (sourceRun.status !== "interrupted") return errorResponse(409, "Only interrupted runs can be resumed");
      if (!sourceRun.inputId) return errorResponse(409, "This interrupted run has no prompt to replay");
      const sourceInput = context.store.getInput(sourceRun.inputId);
      if (!sourceInput || sourceInput.sessionId !== sessionId) {
        return errorResponse(409, "The original prompt is unavailable");
      }

      const existingRecovery = context.store.listInputs(sessionId).find((input) =>
        isRecord(input.metadata.recovery) && input.metadata.recovery.sourceRunId === sourceRun.id,
      );
      if (existingRecovery && existingRecovery.id === body.id) {
        const existingRun = context.store.findRunByInput(existingRecovery.id);
        return jsonResponse({
          input: existingRecovery,
          ...(existingRun ? { run: existingRun } : {}),
          ...(existingRun?.status === "running" ? { queue_state: "running" as const } : {}),
          ...(existingRun?.status === "pending" ? { queue_state: "queued" as const } : {}),
          source_run: sourceRun,
        }, 202);
      }
      if (existingRecovery) {
        return errorResponse(409, `Interrupted run already has a recovery: ${sourceRun.id}`);
      }
      if (!context.hasRuntime()) return errorResponse(409, "Session runtime is unavailable");
      if (context.hasRunWork(sessionId)) {
        return errorResponse(409, "Wait for the active session run before resuming interrupted work");
      }

      try {
        const resumed = context.admitPromptAndMaybeRun(sessionId, {
          id: typeof body.id === "string" ? body.id : undefined,
          content: sourceInput.content,
          metadata: {
            ...(isRecord(body.metadata) ? body.metadata : {}),
            recovery: {
              kind: "prompt_replay",
              sourceRunId: sourceRun.id,
              sourceInputId: sourceInput.id,
            },
          },
          runMetadata: {
            recovery: {
              kind: "prompt_replay",
              sourceRunId: sourceRun.id,
              sourceInputId: sourceInput.id,
            },
          },
          traceId: context.traceIdForRequest(c.req.raw),
        });
        const beforeRecoveryEvent = context.latestEventSeq();
        context.store.appendEvent({
          type: "session.run.recovery_requested",
          sessionId,
          payload: {
            sourceRunId: sourceRun.id,
            sourceInputId: sourceInput.id,
            recoveryInputId: resumed.input.id,
            recoveryRunId: resumed.run?.id,
          },
        });
        context.broadcastSince(beforeRecoveryEvent);
        return jsonResponse({ ...resumed, source_run: sourceRun }, 202);
      } catch (error) {
        return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
      }
    })
    .post("/:sessionId/interrupt", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      return jsonResponse(context.interruptSession(sessionId));
    });
}
