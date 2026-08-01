import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";

import type { StreamEvent } from "@openharness/core";
import {
  SessionStore,
  type PermissionStatus,
  type SessionEventRecord,
} from "@openharness/services";

import { getDefaultSessionStorePath } from "./paths.js";
import { StorePermissionBroker } from "./permission-broker.js";
import { RunInterruptedError, SessionRunCoordinator } from "./run-coordinator.js";
import type { SessionRuntime, SessionRuntimeFactory } from "./runtime.js";

export interface OpenHarnessServerOptions {
  host?: string;
  port?: number;
  token?: string;
  store?: SessionStore;
  storePath?: string;
  runtimeFactory?: SessionRuntimeFactory;
  version?: string;
}

export interface OpenHarnessServerHealth {
  ok: true;
  version?: string;
}

export interface ListenResult {
  host: string;
  port: number;
  url: string;
}

type JsonRecord = Record<string, unknown>;
type Listener = ReturnType<typeof serve>;
type SseClient = {
  sessionId?: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
};
type ActiveToolPart = {
  partId: string;
  messageId: string;
  toolName: string;
  input: Record<string, unknown>;
};
type ActiveRunRenderState = {
  sessionId: string;
  runId: string;
  inputId: string;
  assistantMessageId?: string;
  assistantTurnCompleted: boolean;
  activeTextPartId?: string;
  toolParts: Map<string, ActiveToolPart>;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SSE_HEADERS = {
  "cache-control": "no-cache",
  "connection": "keep-alive",
  "content-type": "text/event-stream; charset=utf-8",
};

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readCursor(c: Context): number | undefined {
  return readLimit(c.req.query("cursor") ?? c.req.query("afterSeq"));
}

function readPermissionStatus(value: string | undefined): PermissionStatus | undefined {
  if (!value) return undefined;
  if (value === "pending" || value === "approved" || value === "denied" || value === "expired") return value;
  throw new Error("Invalid permission status");
}

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      ...JSON_HEADERS,
      "content-length": String(Buffer.byteLength(text)),
    },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

async function readJson(c: Context): Promise<JsonRecord> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new Error("Request body too large");
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error("Request body must be a JSON object");
  return parsed;
}

export class OpenHarnessHttpServer {
  readonly app: Hono;
  readonly store: SessionStore;
  readonly token?: string;
  private readonly runtimeFactory?: SessionRuntimeFactory;
  private readonly version?: string;
  private readonly permissionBroker: StorePermissionBroker;
  private readonly runCoordinator = new SessionRunCoordinator();
  private readonly encoder = new TextEncoder();
  private readonly sseClients = new Set<SseClient>();
  private readonly runtimes = new Map<string, Promise<SessionRuntime>>();
  private listener?: Listener;
  private listenResult?: ListenResult;

  constructor(options: OpenHarnessServerOptions = {}) {
    this.app = new Hono();
    this.store = options.store ?? new SessionStore({ path: options.storePath ?? getDefaultSessionStorePath() });
    this.store.interruptActiveRuns();
    this.token = options.token;
    this.runtimeFactory = options.runtimeFactory;
    this.version = options.version;
    this.permissionBroker = new StorePermissionBroker({
      store: this.store,
      onChange: (previousEventSeq) => this.broadcastSince(previousEventSeq),
    });
    this.mountRoutes();
  }

  get url(): string | undefined {
    return this.listenResult?.url;
  }

  async listen(options: Pick<OpenHarnessServerOptions, "host" | "port"> = {}): Promise<ListenResult> {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    return await new Promise<ListenResult>((resolve, reject) => {
      const listener = serve(
        {
          fetch: this.app.fetch,
          hostname: host,
          port,
        },
        (info) => {
          this.listener = listener;
          this.listenResult = {
            host,
            port: info.port,
            url: `http://${host}:${info.port}`,
          };
          resolve(this.listenResult);
        },
      );
      listener.once("error", reject);
    });
  }

  async close(): Promise<void> {
    for (const client of this.sseClients) {
      try {
        client.controller.close();
      } catch {
        // Client may already be gone.
      }
    }
    this.sseClients.clear();
    await this.closeAllRuntimes();
    if (!this.listener) return;
    await new Promise<void>((resolve, reject) => {
      this.listener!.close((error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.listener = undefined;
  }

  private mountRoutes(): void {
    this.app.onError((error) => errorResponse(500, error instanceof Error ? error.message : String(error)));

    this.app.use("*", async (c, next) => {
      if (!this.authorized(c)) return errorResponse(401, "Unauthorized");
      await next();
    });

    this.app.get("/health", () => jsonResponse({
      ok: true,
      ...(this.version ? { version: this.version } : {}),
    } satisfies OpenHarnessServerHealth));
    this.app.get("/sessions", (c) => this.handleListSessions(c));
    this.app.post("/sessions", (c) => this.handleCreateSession(c));
    this.app.get("/sessions/:sessionId", (c) => this.handleGetSession(c));
    this.app.get("/sessions/:sessionId/state", (c) => this.handleGetSessionState(c));
    this.app.delete("/sessions/:sessionId", (c) => this.handleArchiveSession(c));
    this.app.get("/sessions/:sessionId/messages", (c) => this.handleListMessages(c));
    this.app.get("/sessions/:sessionId/parts", (c) => this.handleListMessageParts(c));
    this.app.post("/sessions/:sessionId/prompts", (c) => this.handleAdmitPrompt(c));
    this.app.post("/sessions/:sessionId/interrupt", (c) => this.handleInterruptSession(c));
    this.app.get("/permissions", (c) => this.handleListPermissions(c));
    this.app.post("/permissions/:requestId/reply", (c) => this.handleReplyPermission(c));
    this.app.get("/events", (c) => this.handleListEvents(c));
    this.app.get("/events/stream", (c) => this.handleEventStream(c));
  }

  private authorized(c: Context): boolean {
    if (!this.token) return true;
    return c.req.header("authorization") === `Bearer ${this.token}`;
  }

  private handleListSessions(c: Context): Response {
    const sessions = this.store.listSessions({
      cwd: c.req.query("cwd") ?? undefined,
      includeArchived: c.req.query("includeArchived") === "true",
      limit: readLimit(c.req.query("limit")),
    });
    return jsonResponse({ sessions });
  }

  private async handleCreateSession(c: Context): Promise<Response> {
    const before = this.latestEventSeq();
    const body = await readJson(c);
    if (typeof body.cwd !== "string") return errorResponse(400, "cwd is required");
    if (typeof body.model !== "string") return errorResponse(400, "model is required");

    const session = this.store.createSession({
      id: typeof body.id === "string" ? body.id : undefined,
      parentId: typeof body.parentId === "string" ? body.parentId : undefined,
      cwd: body.cwd,
      title: typeof body.title === "string" ? body.title : undefined,
      model: body.model,
      agent: typeof body.agent === "string" ? body.agent : undefined,
      metadata: isRecord(body.metadata) ? body.metadata : undefined,
    });
    void this.warmRuntime(session.id);
    this.broadcastSince(before);
    return jsonResponse({ session }, 201);
  }

  private handleGetSession(c: Context): Response {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const session = this.store.getSession(sessionId);
    if (!session) return errorResponse(404, "Session not found");
    void this.warmRuntime(sessionId);
    return jsonResponse({ session });
  }

  private handleGetSessionState(c: Context): Response {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    try {
      return jsonResponse(this.store.getSessionState(sessionId));
    } catch (error) {
      return errorResponse(404, error instanceof Error ? error.message : String(error));
    }
  }

  private handleArchiveSession(c: Context): Response {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const before = this.latestEventSeq();
    try {
      const session = this.store.archiveSession(sessionId);
      void this.closeRuntime(sessionId);
      this.broadcastSince(before);
      return jsonResponse({ session });
    } catch (error) {
      return errorResponse(404, error instanceof Error ? error.message : String(error));
    }
  }

  private handleListMessages(c: Context): Response {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    try {
      const messages = this.store.listMessages(sessionId, {
        afterSeq: readCursor(c),
        limit: readLimit(c.req.query("limit")),
      });
      return jsonResponse({ messages });
    } catch (error) {
      return errorResponse(404, error instanceof Error ? error.message : String(error));
    }
  }

  private handleListMessageParts(c: Context): Response {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    try {
      const parts = this.store.listMessageParts(sessionId, {
        afterSeq: readCursor(c),
        messageId: c.req.query("messageId") ?? undefined,
        limit: readLimit(c.req.query("limit")),
      });
      return jsonResponse({ parts });
    } catch (error) {
      return errorResponse(404, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleAdmitPrompt(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const before = this.latestEventSeq();
    const body = await readJson(c);
    if (typeof body.content !== "string") return errorResponse(400, "content is required");

    try {
      const input = this.store.admitPrompt({
        id: typeof body.id === "string" ? body.id : undefined,
        sessionId,
        delivery: body.delivery === "steer" ? "steer" : "queue",
        content: body.content,
        metadata: isRecord(body.metadata) ? body.metadata : undefined,
      });
      const run = this.runtimeFactory
        ? this.store.createRun({ sessionId, inputId: input.id })
        : undefined;
      this.broadcastSince(before);
      let queueState: "running" | "queued" | undefined;
      if (run) {
        const enqueued = this.runCoordinator.enqueue({
          sessionId,
          runId: run.id,
          work: (context) => this.executeRun(sessionId, input.id, run.id, context),
        });
        queueState = enqueued.state;
        enqueued.promise.catch(() => {
          // The persisted run state is updated by executeRun or interrupt handling.
        });
      }
      return jsonResponse({ input, ...(run ? { run, queue_state: queueState } : {}) }, 202);
    } catch (error) {
      return errorResponse(404, error instanceof Error ? error.message : String(error));
    }
  }

  private handleInterruptSession(c: Context): Response {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const before = this.latestEventSeq();
    const result = this.runCoordinator.interrupt(sessionId);
    if (result.interrupted) {
      for (const runId of result.queuedRunIds) {
        this.store.updateRun(runId, { status: "interrupted", error: "Queued run interrupted" });
      }
      this.store.appendEvent({
        type: "session.run.interrupt_requested",
        sessionId,
        payload: { runId: result.activeRunId, queuedRunIds: result.queuedRunIds },
      });
      this.broadcastSince(before);
    }
    return jsonResponse(result);
  }

  private async executeRun(
    sessionId: string,
    inputId: string,
    runId: string,
    context: { signal: AbortSignal; wakeCount(): number },
  ): Promise<void> {
    if (!this.runtimeFactory) return;
    let before = this.latestEventSeq();
    try {
      const session = this.store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const history = this.store.listMessages(sessionId);
      const parts = this.store.listMessageParts(sessionId);
      const admitted = this.store.getInput(inputId);
      if (!admitted) throw new Error(`Session input not found: ${inputId}`);

      this.store.updateRun(runId, { status: "running" });
      const renderState = this.createRunRenderState(sessionId, inputId, runId, admitted.content);
      this.broadcastSince(before);

      const runtime = await this.getOrCreateRuntime(session, history, parts);
      await runtime.runPrompt(
        { session, input: admitted, runId, history, parts, signal: context.signal, wakeCount: context.wakeCount },
        {
          onEvent: (event) => {
            const eventBefore = this.latestEventSeq();
            this.store.appendEvent({
              type: event.type,
              sessionId,
              payload: event.payload,
            });
            this.broadcastSince(eventBefore);
          },
          onStreamEvent: (event) => {
            const eventBefore = this.latestEventSeq();
            this.applyStreamEvent(renderState, event);
            this.broadcastSince(eventBefore);
          },
          askPermission: (request) =>
            this.permissionBroker.ask({
              sessionId,
              runId,
              toolName: request.toolName,
              reason: request.reason,
              input: request.input,
              signal: context.signal,
            }),
        },
      );

      before = this.latestEventSeq();
      this.completeActiveTextPart(renderState, "completed");
      this.store.updateRun(runId, { status: context.signal.aborted ? "interrupted" : "completed" });
      this.broadcastSince(before);
    } catch (error) {
      await this.closeRuntime(sessionId);
      before = this.latestEventSeq();
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RunInterruptedError || context.signal.aborted) {
        this.store.appendEvent({ type: "session.run.interrupted", sessionId, payload: { runId, error: message } });
        this.store.updateRun(runId, { status: "interrupted", error: message });
      } else {
        this.store.appendEvent({ type: "session.run.error", sessionId, payload: { runId, error: message } });
        this.store.updateRun(runId, { status: "failed", error: message });
      }
      this.broadcastSince(before);
    }
  }

  private createRunRenderState(
    sessionId: string,
    inputId: string,
    runId: string,
    content: string,
  ): ActiveRunRenderState {
    const userMessage = this.store.createMessage({
      sessionId,
      role: "user",
      runId,
      inputId,
    });
    this.store.upsertMessagePart({
      sessionId,
      messageId: userMessage.id,
      type: "text",
      status: "completed",
      text: content,
    });
    return {
      sessionId,
      runId,
      inputId,
      assistantTurnCompleted: false,
      toolParts: new Map(),
    };
  }

  private applyStreamEvent(state: ActiveRunRenderState, event: StreamEvent): void {
    switch (event.type) {
      case "text_delta": {
        const messageId = this.ensureAssistantMessage(state, true);
        if (!state.activeTextPartId) {
          const part = this.store.upsertMessagePart({
            sessionId: state.sessionId,
            messageId,
            type: "text",
            status: "running",
            text: "",
          });
          state.activeTextPartId = part.id;
        }
        this.store.appendMessagePartDelta({
          sessionId: state.sessionId,
          messageId,
          partId: state.activeTextPartId,
          field: "text",
          delta: event.delta,
        });
        break;
      }
      case "tool_use_start": {
        this.completeActiveTextPart(state, "completed");
        const messageId = this.ensureAssistantMessage(state, true);
        const part = this.store.upsertMessagePart({
          id: event.toolUse.id,
          sessionId: state.sessionId,
          messageId,
          type: "tool",
          status: "running",
          toolUseId: event.toolUse.id,
          toolName: event.toolUse.name,
          input: event.toolUse.input,
        });
        state.toolParts.set(event.toolUse.id, {
          partId: part.id,
          messageId,
          toolName: event.toolUse.name,
          input: event.toolUse.input,
        });
        break;
      }
      case "tool_use_end": {
        const active = state.toolParts.get(event.toolUseId);
        const messageId = active?.messageId ?? this.ensureAssistantMessage(state);
        this.store.upsertMessagePart({
          id: active?.partId ?? event.toolUseId,
          sessionId: state.sessionId,
          messageId,
          type: "tool",
          status: event.result.isError ? "failed" : "completed",
          toolUseId: event.toolUseId,
          ...(active?.toolName ? { toolName: active.toolName } : {}),
          ...(active?.input ? { input: active.input } : {}),
          output: event.result,
          isError: event.result.isError === true,
        });
        state.toolParts.delete(event.toolUseId);
        break;
      }
      case "usage": {
        this.store.updateRun(state.runId, { metadata: { usage: event.usage } });
        break;
      }
      case "complete": {
        this.completeActiveTextPart(state, "completed");
        state.assistantTurnCompleted = true;
        this.store.updateRun(state.runId, { metadata: { stopReason: event.stopReason } });
        break;
      }
      case "error": {
        const messageId = this.ensureAssistantMessage(state, true);
        this.completeActiveTextPart(state, "failed");
        this.store.upsertMessagePart({
          sessionId: state.sessionId,
          messageId,
          type: "error",
          status: "failed",
          text: event.error.message,
        });
        break;
      }
    }
  }

  private ensureAssistantMessage(state: ActiveRunRenderState, startTurn = false): string {
    if (startTurn && state.assistantTurnCompleted) {
      delete state.assistantMessageId;
      state.assistantTurnCompleted = false;
    }
    if (state.assistantMessageId) return state.assistantMessageId;
    const message = this.store.createMessage({
      sessionId: state.sessionId,
      role: "assistant",
      runId: state.runId,
    });
    state.assistantMessageId = message.id;
    return message.id;
  }

  private completeActiveTextPart(
    state: ActiveRunRenderState,
    status: "completed" | "failed" | "interrupted",
  ): void {
    if (!state.assistantMessageId || !state.activeTextPartId) return;
    this.store.upsertMessagePart({
      id: state.activeTextPartId,
      sessionId: state.sessionId,
      messageId: state.assistantMessageId,
      type: "text",
      status,
    });
    delete state.activeTextPartId;
  }

  private async getOrCreateRuntime(
    session: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["session"],
    history: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["history"],
    parts: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["parts"],
  ): Promise<SessionRuntime> {
    if (!this.runtimeFactory) throw new Error("Runtime factory is not configured");
    const existing = this.runtimes.get(session.id);
    if (existing) return await existing;

    const promise = this.runtimeFactory.createRuntime({ session, history, parts }).catch((error) => {
      if (this.runtimes.get(session.id) === promise) this.runtimes.delete(session.id);
      throw error;
    });
    this.runtimes.set(session.id, promise);
    return await promise;
  }

  private async warmRuntime(sessionId: string): Promise<void> {
    if (!this.runtimeFactory || this.runtimes.has(sessionId)) return;
    const session = this.store.getSession(sessionId);
    if (!session || session.status === "archived") return;
    const history = this.store.listMessages(sessionId);
    const parts = this.store.listMessageParts(sessionId);
    await this.getOrCreateRuntime(session, history, parts).catch(() => {});
  }

  private async closeRuntime(sessionId: string): Promise<void> {
    const runtimePromise = this.runtimes.get(sessionId);
    if (!runtimePromise) return;
    this.runtimes.delete(sessionId);
    try {
      const runtime = await runtimePromise;
      await runtime.close();
    } catch {
      // Runtime may have failed while being created; nothing else to close.
    }
  }

  private async closeAllRuntimes(): Promise<void> {
    const sessionIds = [...this.runtimes.keys()];
    await Promise.all(sessionIds.map((sessionId) => this.closeRuntime(sessionId)));
  }

  private handleListEvents(c: Context): Response {
    const events = this.store.listEvents({
      afterSeq: readCursor(c),
      sessionId: c.req.query("sessionId") ?? undefined,
      limit: readLimit(c.req.query("limit")),
    });
    return jsonResponse({ events });
  }

  private handleListPermissions(c: Context): Response {
    let status: PermissionStatus | undefined;
    try {
      status = readPermissionStatus(c.req.query("status"));
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }
    const requests = this.permissionBroker.listRequests({
      sessionId: c.req.query("sessionId") ?? undefined,
      status,
      toolName: c.req.query("toolName") ?? undefined,
      limit: readLimit(c.req.query("limit")),
    });
    return jsonResponse({ requests });
  }

  private async handleReplyPermission(c: Context): Promise<Response> {
    const requestId = c.req.param("requestId");
    if (!requestId) return errorResponse(400, "requestId is required");
    const body = await readJson(c);
    const status = body.status;
    if (status !== "approved" && status !== "denied" && status !== "expired") {
      return errorResponse(400, "status must be approved, denied, or expired");
    }
    const decision = body.decision;
    if (decision !== undefined && decision !== "once" && decision !== "session") {
      return errorResponse(400, "decision must be once or session");
    }

    try {
      const request = this.permissionBroker.reply({
        requestId,
        status,
        decision,
        clientId: typeof body.clientId === "string" ? body.clientId : undefined,
      });
      return jsonResponse({ request });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message.includes("not found") ? 404 : 409, message);
    }
  }

  private handleEventStream(c: Context): Response {
    const sessionId = c.req.query("sessionId") ?? undefined;
    let client: SseClient | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = { sessionId, controller };
        this.sseClients.add(client);
        controller.enqueue(this.encoder.encode(": connected\n\n"));
        for (const event of this.store.listEvents({ afterSeq: readCursor(c), sessionId })) {
          this.writeSse(client, event);
        }
      },
      cancel: () => {
        if (client) this.sseClients.delete(client);
      },
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  }

  private latestEventSeq(): number {
    return this.store.listEvents({ limit: Number.MAX_SAFE_INTEGER }).at(-1)?.seq ?? 0;
  }

  private broadcastSince(seq: number): void {
    const events = this.store.listEvents({ afterSeq: seq });
    for (const event of events) {
      for (const client of this.sseClients) {
        if (client.sessionId && event.sessionId && event.sessionId !== client.sessionId) continue;
        this.writeSse(client, event);
      }
    }
  }

  private writeSse(client: SseClient, event: SessionEventRecord): void {
    try {
      client.controller.enqueue(
        this.encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      );
    } catch {
      this.sseClients.delete(client);
    }
  }
}

export async function startOpenHarnessServer(options: OpenHarnessServerOptions = {}): Promise<{
  server: OpenHarnessHttpServer;
  listen: ListenResult;
}> {
  const server = new OpenHarnessHttpServer(options);
  const listen = await server.listen(options);
  return { server, listen };
}
