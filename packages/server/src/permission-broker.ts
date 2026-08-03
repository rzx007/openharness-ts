import type { PermissionRequestRecord, PermissionStatus, SessionStore } from "@openharness/services";
import type { StructuredLogger } from "./observability.js";

export type PermissionReplyStatus = Extract<PermissionStatus, "approved" | "denied" | "expired">;
export type PermissionDecisionScope = "once" | "session";

export interface PermissionAskInput {
  sessionId: string;
  runId?: string;
  traceId?: string;
  toolName: string;
  reason?: string;
  input?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface PermissionReplyInput {
  requestId: string;
  traceId?: string;
  status: PermissionReplyStatus;
  decision?: PermissionDecisionScope;
  clientId?: string;
}

export interface ListPermissionRequestsInput {
  sessionId?: string;
  status?: PermissionStatus;
  toolName?: string;
  limit?: number;
}

export interface PermissionBroker {
  ask(input: PermissionAskInput): Promise<boolean>;
  reply(input: PermissionReplyInput): PermissionRequestRecord;
  getRequest(requestId: string): PermissionRequestRecord | undefined;
  listRequests(input?: ListPermissionRequestsInput): PermissionRequestRecord[];
}

export interface StorePermissionBrokerOptions {
  store: SessionStore;
  onChange?: (previousEventSeq: number) => void;
  logger?: StructuredLogger;
}

type Waiter = (request: PermissionRequestRecord) => void;

export class StorePermissionBroker implements PermissionBroker {
  private readonly store: SessionStore;
  private readonly onChange?: (previousEventSeq: number) => void;
  private readonly logger?: StructuredLogger;
  private readonly waiters = new Map<string, Set<Waiter>>();

  constructor(options: StorePermissionBrokerOptions) {
    this.store = options.store;
    this.onChange = options.onChange;
    this.logger = options.logger;
  }

  async ask(input: PermissionAskInput): Promise<boolean> {
    const permissionSessionId = this.resolvePermissionSessionId(input.sessionId);
    const reusable = this.findSessionApproval(input.sessionId, input.toolName);
    const previousEventSeq = this.latestEventSeq();
    const request = this.store.createPermissionRequest({
      sessionId: permissionSessionId,
      runId: permissionSessionId === input.sessionId ? input.runId : undefined,
      toolName: input.toolName,
      payload: {
        reason: input.reason,
        input: input.input ?? {},
        ...(permissionSessionId !== input.sessionId ? { childSessionId: input.sessionId } : {}),
        ...(permissionSessionId !== input.sessionId && input.runId ? { childRunId: input.runId } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
        ...(reusable ? { reusedApprovalRequestId: reusable.id } : {}),
      },
    });
    this.notify(previousEventSeq);
    this.logger?.({
      level: "info",
      event: "permission.requested",
      traceId: input.traceId,
      sessionId: permissionSessionId,
      runId: input.runId,
      requestId: request.id,
      toolName: input.toolName,
    });

    if (reusable) {
      const beforeReply = this.latestEventSeq();
      const replied = this.store.replyPermission({
        requestId: request.id,
        status: "approved",
        decision: "session",
      });
      this.notify(beforeReply);
      this.logger?.({
        level: "info",
        event: "permission.auto_approved",
        traceId: input.traceId,
        sessionId: request.sessionId,
        runId: request.runId,
        requestId: request.id,
        toolName: request.toolName,
      });
      return replied.status === "approved";
    }

    if (input.signal?.aborted) {
      this.expire(request.id, "Run interrupted before permission reply");
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      const waiter: Waiter = (replied) => {
        cleanup();
        resolve(replied.status === "approved");
      };
      const abort = () => {
        cleanup();
        this.expire(request.id, "Run interrupted while waiting for permission");
        resolve(false);
      };
      const cleanup = () => {
        const waiters = this.waiters.get(request.id);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.waiters.delete(request.id);
        input.signal?.removeEventListener("abort", abort);
      };

      const waiters = this.waiters.get(request.id) ?? new Set<Waiter>();
      waiters.add(waiter);
      this.waiters.set(request.id, waiters);
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
    });
  }

  reply(input: PermissionReplyInput): PermissionRequestRecord {
    const current = this.store.getPermissionRequest(input.requestId);
    if (!current) throw new Error(`Permission request not found: ${input.requestId}`);
    if (current.status !== "pending") throw new Error(`Permission request already resolved: ${input.requestId}`);

    const previousEventSeq = this.latestEventSeq();
    const replied = this.store.replyPermission({
      requestId: input.requestId,
      status: input.status,
      decision: input.decision,
      clientId: input.clientId,
    });
    this.notify(previousEventSeq);
    this.resolveWaiters(replied);
    this.logger?.({
      level: "info",
      event: "permission.replied",
      traceId: this.traceIdFromRequest(replied) ?? input.traceId,
      sessionId: replied.sessionId,
      runId: replied.runId,
      requestId: replied.id,
      toolName: replied.toolName,
    });
    return replied;
  }

  getRequest(requestId: string): PermissionRequestRecord | undefined {
    return this.store.getPermissionRequest(requestId);
  }

  listRequests(input: ListPermissionRequestsInput = {}): PermissionRequestRecord[] {
    return this.store.listPermissionRequests(input);
  }

  private findSessionApproval(sessionId: string, toolName: string): PermissionRequestRecord | undefined {
    for (const candidateId of this.sessionLineage(sessionId)) {
      const approval = this.store
        .listPermissionRequests({ sessionId: candidateId, toolName, status: "approved" })
        .filter((request) => request.decision === "session")
        .at(-1);
      if (approval) return approval;
    }
    return undefined;
  }

  private resolvePermissionSessionId(sessionId: string): string {
    return this.sessionLineage(sessionId).at(-1) ?? sessionId;
  }

  private sessionLineage(sessionId: string): string[] {
    const lineage: string[] = [];
    const seen = new Set<string>();
    let currentId: string | undefined = sessionId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      lineage.push(currentId);
      currentId = this.store.getSession(currentId)?.parentId;
    }
    return lineage;
  }

  private expire(requestId: string, reason: string): void {
    const current = this.store.getPermissionRequest(requestId);
    if (!current || current.status !== "pending") return;
    const previousEventSeq = this.latestEventSeq();
    const expired = this.store.replyPermission({
      requestId,
      status: "expired",
      decision: reason,
    });
    this.notify(previousEventSeq);
    this.resolveWaiters(expired);
    this.logger?.({
      level: "warn",
      event: "permission.expired",
      traceId: this.traceIdFromRequest(expired),
      sessionId: expired.sessionId,
      runId: expired.runId,
      requestId: expired.id,
      toolName: expired.toolName,
      error: reason,
    });
  }

  private resolveWaiters(request: PermissionRequestRecord): void {
    const waiters = this.waiters.get(request.id);
    if (!waiters) return;
    this.waiters.delete(request.id);
    for (const waiter of waiters) waiter(request);
  }

  private traceIdFromRequest(request: PermissionRequestRecord): string | undefined {
    const traceId = request.payload.traceId;
    return typeof traceId === "string" ? traceId : undefined;
  }

  private latestEventSeq(): number {
    return this.store.latestEventSeq();
  }

  private notify(previousEventSeq: number): void {
    this.onChange?.(previousEventSeq);
  }
}
