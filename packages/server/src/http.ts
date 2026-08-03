import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";

import { cancelPersistentWorkflow, WorkflowRunStore, type WorkflowRunEvent } from "@openharness/coordinator";
import type { StreamEvent } from "@openharness/core";
import {
  SessionStore,
  getTaskManager,
  type TaskInfo,
  type PermissionStatus,
  type SessionEventRecord,
} from "@openharness/services";

import {
  mergeCommandCatalog,
  normalizeCommandName,
  parseSlashLine,
  type CommandCatalogProvider,
} from "./commands.js";
import { getDefaultSessionStorePath } from "./paths.js";
import { StorePermissionBroker } from "./permission-broker.js";
import { RunInterruptedError, SessionRunCoordinator } from "./run-coordinator.js";
import type { ChildSessionHost, SessionRuntime, SessionRuntimeFactory } from "./runtime.js";
import type { SessionTaskBridge } from "./runtime.js";
import { writeSessionExport, type SessionExportFormat } from "./export-session.js";
import type {
  AgentPersonaService,
  AuthService,
  ContextService,
  DreamService,
  GitService,
  HooksService,
  MemoryService,
  OutputStyleService,
  PluginService,
  ProfileService,
  ProjectInitService,
  ProviderService,
  SettingsService,
} from "./settings-api.js";
import { rewindTranscript } from "./rewind.js";
import { estimateCostUsd } from "./usage.js";
import {
  TRACE_ID_HEADER,
  writeStructuredLog,
  type ObservabilityEvent,
  type StructuredLogger,
} from "./observability.js";

export interface OpenHarnessServerOptions {
  host?: string;
  port?: number;
  token?: string;
  /** Exact browser origins permitted to call this daemon. Empty means native/same-origin clients only. */
  allowedOrigins?: string[];
  store?: SessionStore;
  storePath?: string;
  runtimeFactory?: SessionRuntimeFactory;
  commandCatalog?: CommandCatalogProvider;
  settingsService?: SettingsService;
  providerService?: ProviderService;
  memoryService?: MemoryService;
  authService?: AuthService;
  contextService?: ContextService;
  dreamService?: DreamService;
  profileService?: ProfileService;
  outputStyleService?: OutputStyleService;
  projectInitService?: ProjectInitService;
  pluginService?: PluginService;
  agentPersonaService?: AgentPersonaService;
  hooksService?: HooksService;
  gitService?: GitService;
  version?: string;
  logger?: StructuredLogger;
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
const DAEMON_RESTART_RUN_REASON = "Daemon restarted before the run completed";
const DAEMON_RESTART_TASK_REASON = "Daemon restarted before the task completed";
const DAEMON_RESTART_WORKFLOW_REASON = "Daemon restarted before the workflow completed";
type SseClient = {
  sessionId?: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat?: ReturnType<typeof setInterval>;
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
const CORS_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "authorization, content-type, last-event-id, x-openharness-trace-id";

const RUNTIME_SESSION_METADATA_KEYS = [
  "permissionMode",
  "maxTurns",
  "systemPrompt",
  "allowedTools",
  "disallowedTools",
  "effort",
] as const;

function runtimeSessionMetadataChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return RUNTIME_SESSION_METADATA_KEYS.some(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeTraceId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : undefined;
}

function withoutTraceId(metadata: Record<string, unknown>): Record<string, unknown> {
  const { traceId: _traceId, ...rest } = metadata;
  return rest;
}

function normalizeAllowedOrigins(origins: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const value of origins) {
    if (value === "*") throw new Error("Wildcard CORS origins are not supported");
    let origin: URL;
    try {
      origin = new URL(value);
    } catch {
      throw new Error(`Invalid allowed origin: ${value}`);
    }
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== value.replace(/\/$/, "")) {
      throw new Error(`Allowed origin must be an http(s) origin without a path: ${value}`);
    }
    normalized.add(origin.origin);
  }
  return normalized;
}

function workflowRunIdFromSessionEvent(event: SessionEventRecord): string | undefined {
  const workflowEvent = event.payload.event;
  return isRecord(workflowEvent) && typeof workflowEvent.runId === "string"
    ? workflowEvent.runId
    : undefined;
}

function readLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readCursor(c: Context): number | undefined {
  return readLimit(c.req.query("cursor") ?? c.req.query("afterSeq"));
}

function readEventCursor(c: Context): number | undefined {
  return readCursor(c) ?? readLimit(c.req.header("last-event-id"));
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]),
    );
  }
  return false;
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

function sessionMutationErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Session is archived:") ||
    message.startsWith("Session is closing:") ||
    message.startsWith("Prompt id is already used:")
    ? 409
    : 404;
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
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly runtimeFactory?: SessionRuntimeFactory;
  private readonly commandCatalog?: CommandCatalogProvider;
  private readonly settingsService?: SettingsService;
  private readonly providerService?: ProviderService;
  private readonly memoryService?: MemoryService;
  private readonly authService?: AuthService;
  private readonly contextService?: ContextService;
  private readonly dreamService?: DreamService;
  private readonly profileService?: ProfileService;
  private readonly outputStyleService?: OutputStyleService;
  private readonly projectInitService?: ProjectInitService;
  private readonly pluginService?: PluginService;
  private readonly agentPersonaService?: AgentPersonaService;
  private readonly hooksService?: HooksService;
  private readonly gitService?: GitService;
  private readonly version?: string;
  private readonly logger: StructuredLogger;
  private readonly permissionBroker: StorePermissionBroker;
  private readonly childSessionHost: ChildSessionHost;
  private readonly runCoordinator = new SessionRunCoordinator();
  private readonly encoder = new TextEncoder();
  private readonly sseClients = new Set<SseClient>();
  private readonly runtimes = new Map<string, Promise<SessionRuntime>>();
  private readonly runPromises = new Map<string, Promise<void>>();
  private readonly archivePromises = new Map<string, Promise<ReturnType<SessionStore["archiveSession"]>>>();
  private readonly requestTraceIds = new WeakMap<Request, string>();
  private readonly startupRecovery: Promise<void>;
  private listener?: Listener;
  private listenResult?: ListenResult;

  constructor(options: OpenHarnessServerOptions = {}) {
    this.app = new Hono();
    this.store = options.store ?? new SessionStore({ path: options.storePath ?? getDefaultSessionStorePath() });
    this.store.interruptActiveRuns(DAEMON_RESTART_RUN_REASON);
    this.store.interruptActiveSessionTasks(DAEMON_RESTART_TASK_REASON);
    this.store.finalizeClosingSessions();
    this.token = options.token;
    this.allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);
    this.runtimeFactory = options.runtimeFactory;
    this.commandCatalog = options.commandCatalog;
    this.settingsService = options.settingsService;
    this.providerService = options.providerService;
    this.memoryService = options.memoryService;
    this.authService = options.authService;
    this.contextService = options.contextService;
    this.dreamService = options.dreamService;
    this.profileService = options.profileService;
    this.outputStyleService = options.outputStyleService;
    this.projectInitService = options.projectInitService;
    this.pluginService = options.pluginService;
    this.agentPersonaService = options.agentPersonaService;
    this.hooksService = options.hooksService;
    this.gitService = options.gitService;
    this.version = options.version;
    this.logger = options.logger ?? writeStructuredLog;
    this.permissionBroker = new StorePermissionBroker({
      store: this.store,
      onChange: (previousEventSeq) => this.broadcastSince(previousEventSeq),
      logger: (event) => this.log(event),
    });
    this.childSessionHost = {
      createChildSession: async (input) => this.createChildSession(input),
      admitPrompt: async (sessionId, content) => {
        const admitted = this.admitPromptAndMaybeRun(sessionId, { content });
        return { ...(admitted.run ? { runId: admitted.run.id } : {}) };
      },
      awaitRun: async (sessionId, runId) => this.awaitChildRun(sessionId, runId),
      interrupt: async (sessionId) => {
        this.interruptSession(sessionId);
      },
      closeRuntime: async (sessionId) => this.closeRuntime(sessionId),
      archive: async (sessionId) => {
        await this.archiveSessionTree(sessionId);
      },
    };
    this.startupRecovery = this.recoverInterruptedWorkflows();
    this.mountRoutes();
  }

  get url(): string | undefined {
    return this.listenResult?.url;
  }

  async listen(options: Pick<OpenHarnessServerOptions, "host" | "port"> = {}): Promise<ListenResult> {
    await this.startupRecovery;
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
      this.removeSseClient(client);
    }
    await this.closeAllRuntimes();
    if (this.listener) {
      await new Promise<void>((resolve, reject) => {
        this.listener!.close((error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      this.listener = undefined;
    }
    this.store.close();
  }

  private mountRoutes(): void {
    this.app.onError((error) => errorResponse(500, error instanceof Error ? error.message : String(error)));

    this.app.use("*", async (c, next) => {
      const traceId = normalizeTraceId(c.req.header(TRACE_ID_HEADER)) ?? randomUUID();
      const startedAt = Date.now();
      this.requestTraceIds.set(c.req.raw, traceId);
      try {
        await next();
      } finally {
        c.res.headers.set(TRACE_ID_HEADER, traceId);
        this.log({
          level: "info",
          event: "http.request.completed",
          traceId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: Date.now() - startedAt,
        });
      }
    });

    this.app.use("*", async (c, next) => {
      const origin = c.req.header("origin");
      if (!origin) {
        await next();
        return;
      }
      if (!this.allowedOrigins.has(origin)) return errorResponse(403, "Origin is not allowed");
      const headers = {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": CORS_METHODS,
        "access-control-allow-headers": CORS_HEADERS,
        "access-control-expose-headers": TRACE_ID_HEADER,
        "access-control-max-age": "600",
        vary: "Origin",
      };
      if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers });
      await next();
      for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
    });

    this.app.use("*", async (c, next) => {
      if (!this.authorized(c)) return errorResponse(401, "Unauthorized");
      await next();
    });

    this.app.get("/health", () => jsonResponse({
      ok: true,
      ...(this.version ? { version: this.version } : {}),
    } satisfies OpenHarnessServerHealth));
    this.app.get("/commands", (c) => this.handleListCommands(c));
    this.app.get("/settings", (c) => this.handleGetSettings(c));
    this.app.patch("/settings", (c) => this.handlePatchSettings(c));
    this.app.get("/providers", (c) => this.handleListProviders(c));
    this.app.get("/memory", (c) => this.handleListMemory(c));
    this.app.get("/memory/:entryId", (c) => this.handleGetMemory(c));
    this.app.post("/memory", (c) => this.handleAddMemory(c));
    this.app.delete("/memory/:entryId", (c) => this.handleRemoveMemory(c));
    this.app.get("/auth", (c) => this.handleAuthStatus(c));
    this.app.post("/auth/login", (c) => this.handleAuthLogin(c));
    this.app.post("/auth/logout", (c) => this.handleAuthLogout(c));
    this.app.get("/context", (c) => this.handleContextPreview(c));
    this.app.post("/dream", (c) => this.handleStartDream(c));
    this.app.get("/profile", (c) => this.handleProfileStatus(c));
    this.app.post("/profile/init", (c) => this.handleProfileInit(c));
    this.app.get("/output-styles", (c) => this.handleListOutputStyles(c));
    this.app.post("/project/init", (c) => this.handleProjectInit(c));
    this.app.get("/plugins", (c) => this.handleListPlugins(c));
    this.app.post("/plugins/:name/enable", (c) => this.handleEnablePlugin(c));
    this.app.post("/plugins/:name/disable", (c) => this.handleDisablePlugin(c));
    this.app.post("/plugins/reload", (c) => this.handleReloadPlugins(c));
    this.app.get("/agent-personas", (c) => this.handleListAgentPersonas(c));
    this.app.get("/hooks", (c) => this.handleListHooks(c));
    this.app.get("/git/diff", (c) => this.handleGitDiff(c));
    this.app.get("/git/branch", (c) => this.handleGitBranch(c));
    this.app.get("/git/status", (c) => this.handleGitStatus(c));
    this.app.post("/git/commit", (c) => this.handleGitCommit(c));
    this.app.get("/tasks", (c) => this.handleListTasks(c));
    this.app.post("/tasks", (c) => this.handleCreateTask(c));
    this.app.get("/tasks/:taskId", (c) => this.handleGetTask(c));
    this.app.post("/tasks/:taskId/stop", (c) => this.handleStopTask(c));
    this.app.get("/sessions", (c) => this.handleListSessions(c));
    this.app.post("/sessions", (c) => this.handleCreateSession(c));
    this.app.get("/sessions/:sessionId", (c) => this.handleGetSession(c));
    this.app.patch("/sessions/:sessionId", (c) => this.handleUpdateSession(c));
    this.app.get("/sessions/:sessionId/state", (c) => this.handleGetSessionState(c));
    this.app.delete("/sessions/:sessionId", (c) => this.handleArchiveSession(c));
    this.app.get("/sessions/:sessionId/mcp", (c) => this.handleGetSessionMcp(c));
    this.app.get("/sessions/:sessionId/usage", (c) => this.handleGetSessionUsage(c));
    this.app.post("/sessions/:sessionId/export", (c) => this.handleExportSession(c));
    this.app.post("/sessions/:sessionId/compact", (c) => this.handleCompactSession(c));
    this.app.post("/sessions/:sessionId/rewind", (c) => this.handleRewindSession(c));
    this.app.post("/sessions/:sessionId/remember", (c) => this.handleRememberSession(c));
    this.app.get("/sessions/:sessionId/messages", (c) => this.handleListMessages(c));
    this.app.get("/sessions/:sessionId/parts", (c) => this.handleListMessageParts(c));
    this.app.post("/sessions/:sessionId/prompts", (c) => this.handleAdmitPrompt(c));
    this.app.post("/sessions/:sessionId/runs/:runId/resume", (c) => this.handleResumeInterruptedRun(c));
    this.app.post("/sessions/:sessionId/commands", (c) => this.handleInvokeCommand(c));
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

  private traceIdForContext(c: Context): string {
    return this.requestTraceIds.get(c.req.raw) ?? randomUUID();
  }

  private log(event: ObservabilityEvent): void {
    this.logger(event);
  }

  private traceIdForRun(runId: string): string {
    const run = this.store.getRun(runId);
    const traceId = normalizeTraceId(run?.metadata.traceId);
    if (traceId) return traceId;
    const generated = randomUUID();
    if (run) this.store.updateRun(runId, { metadata: { traceId: generated } });
    return generated;
  }

  private async handleListCommands(c: Context): Promise<Response> {
    const cwd = c.req.query("cwd");
    if (!cwd) return errorResponse(400, "cwd is required");
    try {
      const extras = this.commandCatalog ? await this.commandCatalog.list({ cwd }) : [];
      return jsonResponse({ commands: mergeCommandCatalog(extras) });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleGetSettings(c: Context): Promise<Response> {
    if (!this.settingsService) return errorResponse(501, "Settings service is not configured");
    try {
      return jsonResponse({ settings: await this.settingsService.get() });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handlePatchSettings(c: Context): Promise<Response> {
    if (!this.settingsService) return errorResponse(501, "Settings service is not configured");
    if (this.hasAnyActiveRuns()) {
      return errorResponse(409, "Cannot update daemon settings while session runs are active");
    }
    const body = await readJson(c);
    try {
      const result = await this.settingsService.patch(body);
      if (result.restartRuntimes) await this.closeAllRuntimes();
      return jsonResponse({ settings: result.settings });
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleListProviders(c: Context): Promise<Response> {
    if (!this.providerService) return errorResponse(501, "Provider service is not configured");
    try {
      return jsonResponse({ providers: await this.providerService.list() });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleListMemory(c: Context): Promise<Response> {
    if (!this.memoryService) return errorResponse(501, "Memory service is not configured");
    const cwd = c.req.query("cwd");
    if (!cwd) return errorResponse(400, "cwd is required");
    try {
      return jsonResponse(await this.memoryService.list({ cwd }));
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleGetMemory(c: Context): Promise<Response> {
    if (!this.memoryService) return errorResponse(501, "Memory service is not configured");
    const cwd = c.req.query("cwd");
    const entryId = c.req.param("entryId");
    if (!cwd) return errorResponse(400, "cwd is required");
    if (!entryId) return errorResponse(400, "entryId is required");
    try {
      const entry = await this.memoryService.get({ cwd, id: entryId });
      if (!entry) return errorResponse(404, `Memory entry not found: ${entryId}`);
      return jsonResponse({ entry });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleAddMemory(c: Context): Promise<Response> {
    if (!this.memoryService) return errorResponse(501, "Memory service is not configured");
    const body = await readJson(c);
    if (typeof body.cwd !== "string") return errorResponse(400, "cwd is required");
    if (typeof body.content !== "string" || !body.content.trim()) {
      return errorResponse(400, "content is required");
    }
    if (this.hasActiveRunsForCwd(body.cwd)) {
      return errorResponse(409, "Cannot update memory while session runs are active for this cwd");
    }
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === "string")
      : undefined;
    try {
      const entry = await this.memoryService.add({ cwd: body.cwd, content: body.content, tags });
      await this.closeRuntimesForCwd(body.cwd);
      return jsonResponse({ entry }, 201);
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRemoveMemory(c: Context): Promise<Response> {
    if (!this.memoryService) return errorResponse(501, "Memory service is not configured");
    const cwd = c.req.query("cwd");
    const entryId = c.req.param("entryId");
    if (!cwd) return errorResponse(400, "cwd is required");
    if (!entryId) return errorResponse(400, "entryId is required");
    if (this.hasActiveRunsForCwd(cwd)) {
      return errorResponse(409, "Cannot update memory while session runs are active for this cwd");
    }
    try {
      const deleted = await this.memoryService.remove({ cwd, id: entryId });
      if (!deleted) return errorResponse(404, `Memory entry not found: ${entryId}`);
      await this.closeRuntimesForCwd(cwd);
      return jsonResponse({ deleted: true, id: entryId });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleAuthStatus(c: Context): Promise<Response> {
    if (!this.authService) return errorResponse(501, "Auth service is not configured");
    try {
      return jsonResponse({ auth: await this.authService.status() });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleAuthLogin(c: Context): Promise<Response> {
    if (!this.authService) return errorResponse(501, "Auth service is not configured");
    const body = await readJson(c);
    if (typeof body.provider !== "string" || !body.provider.trim()) {
      return errorResponse(400, "provider is required");
    }
    if (this.hasAnyActiveRuns()) {
      return errorResponse(409, "Cannot update authentication while session runs are active");
    }
    try {
      const result = await this.authService.login({
        provider: body.provider,
        apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      });
      await this.closeAllRuntimes();
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleAuthLogout(c: Context): Promise<Response> {
    if (!this.authService) return errorResponse(501, "Auth service is not configured");
    const body = await readJson(c);
    if (typeof body.provider !== "string" || !body.provider.trim()) {
      return errorResponse(400, "provider is required");
    }
    if (this.hasAnyActiveRuns()) {
      return errorResponse(409, "Cannot update authentication while session runs are active");
    }
    try {
      const result = await this.authService.logout({ provider: body.provider });
      await this.closeAllRuntimes();
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleContextPreview(c: Context): Promise<Response> {
    if (!this.contextService) return errorResponse(501, "Context service is not configured");
    const cwd = c.req.query("cwd");
    if (!cwd) return errorResponse(400, "cwd is required");
    try {
      return jsonResponse(await this.contextService.preview({ cwd }));
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleStartDream(c: Context): Promise<Response> {
    if (!this.dreamService) return errorResponse(501, "Dream service is not configured");
    const body = await readJson(c);
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return errorResponse(400, "cwd is required");
    }
    try {
      const result = await this.dreamService.start({
        cwd: body.cwd,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        preview: body.preview === true,
      });
      if (!result.started) {
        return errorResponse(409, result.reason ?? "Dream was not started");
      }
      return jsonResponse({ taskId: result.taskId }, 201);
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleProfileStatus(c: Context): Promise<Response> {
    if (!this.profileService) return errorResponse(501, "Profile service is not configured");
    try {
      return jsonResponse(await this.profileService.status());
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleProfileInit(c: Context): Promise<Response> {
    if (!this.profileService) return errorResponse(501, "Profile service is not configured");
    if (this.hasAnyActiveRuns()) {
      return errorResponse(409, "Cannot initialize profile while session runs are active");
    }
    try {
      const result = await this.profileService.init();
      await this.closeAllRuntimes();
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleListOutputStyles(c: Context): Promise<Response> {
    if (!this.outputStyleService) return errorResponse(501, "Output style service is not configured");
    try {
      return jsonResponse({ styles: await this.outputStyleService.list() });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleProjectInit(c: Context): Promise<Response> {
    if (!this.projectInitService) return errorResponse(501, "Project init service is not configured");
    const body = await readJson(c);
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    if (!cwd) return errorResponse(400, "cwd is required");
    try {
      return jsonResponse(await this.projectInitService.init({ cwd }));
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleListPlugins(c: Context): Promise<Response> {
    if (!this.pluginService) return errorResponse(501, "Plugin service is not configured");
    const cwd = c.req.query("cwd") ?? undefined;
    if (!cwd) return errorResponse(400, "cwd is required");
    try {
      return jsonResponse(await this.pluginService.list({ cwd }));
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleEnablePlugin(c: Context): Promise<Response> {
    return await this.handleSetPluginEnabled(c, true);
  }

  private async handleDisablePlugin(c: Context): Promise<Response> {
    return await this.handleSetPluginEnabled(c, false);
  }

  private async handleSetPluginEnabled(c: Context, enabled: boolean): Promise<Response> {
    if (!this.pluginService) return errorResponse(501, "Plugin service is not configured");
    const name = c.req.param("name");
    if (!name) return errorResponse(400, "plugin name is required");
    if (this.hasAnyActiveRuns()) {
      return errorResponse(409, "Cannot update plugins while session runs are active");
    }
    try {
      const result = await this.pluginService.setEnabled({ name, enabled });
      if (result.restartRuntimes) await this.closeAllRuntimes();
      return jsonResponse({ message: result.message });
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleListAgentPersonas(c: Context): Promise<Response> {
    if (!this.agentPersonaService) return errorResponse(501, "Agent persona service is not configured");
    try {
      return jsonResponse(await this.agentPersonaService.list());
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleListHooks(c: Context): Promise<Response> {
    if (!this.hooksService) return errorResponse(501, "Hooks service is not configured");
    const cwd = c.req.query("cwd") ?? undefined;
    if (!cwd) return errorResponse(400, "cwd is required");
    const sessionId = c.req.query("sessionId") ?? undefined;
    try {
      const listed = await this.hooksService.list({ cwd, ...(sessionId ? { sessionId } : {}) });
      const hooks = [...listed.hooks];
      if (sessionId && this.runtimeFactory) {
        const session = this.store.getSession(sessionId);
        if (!session) return errorResponse(404, "Session not found");
        await this.warmRuntime(sessionId);
        const runtime = this.runtimes.get(sessionId) ? await this.runtimes.get(sessionId)! : undefined;
        if (runtime?.inspect) {
          const inspect = await runtime.inspect();
          for (const hook of inspect.hooks ?? []) {
            if (!hooks.some((row) => row.id === hook.id && row.origin === hook.origin)) {
              hooks.push(hook);
            }
          }
        }
      }
      return jsonResponse({ hooks });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleGitDiff(c: Context): Promise<Response> {
    if (!this.gitService) return errorResponse(501, "Git service is not configured");
    const cwd = c.req.query("cwd") ?? undefined;
    if (!cwd) return errorResponse(400, "cwd is required");
    const full = c.req.query("full") === "true" || c.req.query("full") === "1";
    try {
      return jsonResponse(await this.gitService.diff({ cwd, full }));
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleGitBranch(c: Context): Promise<Response> {
    if (!this.gitService) return errorResponse(501, "Git service is not configured");
    const cwd = c.req.query("cwd") ?? undefined;
    if (!cwd) return errorResponse(400, "cwd is required");
    const list = c.req.query("list") === "true" || c.req.query("list") === "1";
    try {
      return jsonResponse(await this.gitService.branch({ cwd, list }));
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleGitStatus(c: Context): Promise<Response> {
    if (!this.gitService) return errorResponse(501, "Git service is not configured");
    const cwd = c.req.query("cwd") ?? undefined;
    if (!cwd) return errorResponse(400, "cwd is required");
    try {
      return jsonResponse(await this.gitService.status({ cwd }));
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleGitCommit(c: Context): Promise<Response> {
    if (!this.gitService) return errorResponse(501, "Git service is not configured");
    const body = await readJson(c);
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!cwd) return errorResponse(400, "cwd is required");
    if (!message) return errorResponse(400, "message is required");
    try {
      return jsonResponse(await this.gitService.commit({ cwd, message }));
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleReloadPlugins(c: Context): Promise<Response> {
    if (!this.pluginService) return errorResponse(501, "Plugin service is not configured");
    const body = await readJson(c);
    const cwd = typeof body.cwd === "string" ? body.cwd : c.req.query("cwd") ?? undefined;
    if (!cwd) return errorResponse(400, "cwd is required");
    if (this.hasActiveRunsForCwd(cwd)) {
      return errorResponse(409, "Cannot reload plugins while session runs are active for this cwd");
    }
    try {
      await this.closeRuntimesForCwd(cwd);
      const listed = await this.pluginService.list({ cwd });
      return jsonResponse({
        ...listed,
        message: "Plugins rediscovered; session runtimes will reload on next use.",
      });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleGetSessionUsage(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const session = this.store.getSession(sessionId);
    if (!session) return errorResponse(404, "Session not found");
    const messageCount = this.store.listMessages(sessionId).length;
    try {
      await this.warmRuntime(sessionId);
      const runtime = this.runtimes.get(sessionId) ? await this.runtimes.get(sessionId)! : undefined;
      const usage = runtime?.getUsage
        ? await runtime.getUsage()
        : {
          inputTokens: 0,
          outputTokens: 0,
          messageCount,
        };
      const estimatedCost = estimateCostUsd(
        session.model,
        usage.inputTokens,
        usage.outputTokens,
      );
      return jsonResponse({
        model: session.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        messageCount: usage.messageCount ?? messageCount,
        estimatedCost,
      });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleExportSession(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const session = this.store.getSession(sessionId);
    if (!session) return errorResponse(404, "Session not found");
    const body = await readJson(c);
    const forceJson = body.json === true || body.format === "json";
    const filename = typeof body.filename === "string" ? body.filename : undefined;
    const format: SessionExportFormat =
      forceJson || (filename?.endsWith(".json") ?? false) ? "json" : "md";
    try {
      const result = await writeSessionExport({
        session,
        messages: this.store.listMessages(sessionId),
        parts: this.store.listMessageParts(sessionId),
        format,
        filename,
      });
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleCompactSession(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const session = this.store.getSession(sessionId);
    if (!session) return errorResponse(404, "Session not found");
    if (!this.runtimeFactory) return errorResponse(501, "Runtime factory is not configured");
    if (this.runCoordinator.hasWork(sessionId)) {
      return errorResponse(409, "Cannot compact while a run is active");
    }
    try {
      await this.warmRuntime(sessionId);
      const runtime = this.runtimes.get(sessionId) ? await this.runtimes.get(sessionId)! : undefined;
      if (!runtime?.compact) return errorResponse(501, "Session runtime does not support compact");
      const before = this.latestEventSeq();
      const compacted = await runtime.compact();
      const replaced = this.store.replaceTranscript({
        sessionId,
        messages: compacted.transcript,
      });
      this.broadcastSince(before);
      return jsonResponse({
        messageCount: compacted.messageCount,
        messages: replaced.messages,
        parts: replaced.parts,
      });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRewindSession(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const session = this.store.getSession(sessionId);
    if (!session) return errorResponse(404, "Session not found");
    if (this.runCoordinator.hasWork(sessionId)) {
      return errorResponse(409, "Cannot rewind while a run is active");
    }
    const body = await readJson(c);
    const rawCount = body.count ?? 1;
    const count = typeof rawCount === "number" ? rawCount : Number.parseInt(String(rawCount), 10);
    if (!Number.isInteger(count) || count < 1) {
      return errorResponse(400, "count must be a positive integer");
    }
    try {
      const rewound = rewindTranscript(
        this.store.listMessages(sessionId),
        this.store.listMessageParts(sessionId),
        count,
      );
      if (rewound.removed === 0) return errorResponse(400, "No messages to rewind");
      const before = this.latestEventSeq();
      const replaced = this.store.replaceTranscript({
        sessionId,
        messages: rewound.kept,
      });
      await this.closeRuntime(sessionId);
      this.broadcastSince(before);
      return jsonResponse({
        turns: rewound.turns,
        removed: rewound.removed,
        messages: replaced.messages,
        parts: replaced.parts,
      });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRememberSession(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const session = this.store.getSession(sessionId);
    if (!session) return errorResponse(404, "Session not found");
    if (!this.runtimeFactory) return errorResponse(501, "Runtime factory is not configured");
    if (this.hasActiveRunsForCwd(session.cwd)) {
      return errorResponse(409, "Cannot remember while session runs are active for this cwd");
    }
    try {
      await this.warmRuntime(sessionId);
      const runtime = this.runtimes.get(sessionId) ? await this.runtimes.get(sessionId)! : undefined;
      if (!runtime?.remember) return errorResponse(501, "Session runtime does not support remember");
      const result = await runtime.remember();
      await this.closeRuntimesForCwd(session.cwd);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private async closeRuntimesForCwd(cwd: string): Promise<void> {
    const sessions = this.store.listSessions({ cwd, includeArchived: true });
    await Promise.all(sessions.map((session) => this.closeRuntime(session.id)));
  }

  private resolveTaskScope(c: Context): { cwd: string; sessionId?: string } | Response {
    const sessionId = c.req.query("sessionId") ?? undefined;
    let cwd = c.req.query("cwd") ?? undefined;
    if (sessionId) {
      const session = this.store.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");
      cwd = cwd ?? session.cwd;
    }
    if (!cwd) return errorResponse(400, "cwd or sessionId is required");
    return { cwd, ...(sessionId ? { sessionId } : {}) };
  }

  private handleListTasks(c: Context): Response {
    const scope = this.resolveTaskScope(c);
    if (scope instanceof Response) return scope;
    if (scope.sessionId) {
      this.projectManagerTasks(scope.sessionId, getTaskManager(scope));
      const tasks = this.store.listSessionTasks(scope.sessionId);
      const status = c.req.query("status");
      return jsonResponse({ tasks: status ? tasks.filter((task) => task.status === status) : tasks });
    }
    const tasks = getTaskManager(scope).listTasks(c.req.query("status") ?? undefined);
    return jsonResponse({ tasks });
  }

  private async handleCreateTask(c: Context): Promise<Response> {
    const body = await readJson(c);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    let cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    if (sessionId) {
      const session = this.store.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");
      cwd = cwd ?? session.cwd;
    }
    if (!cwd) return errorResponse(400, "cwd or sessionId is required");
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!command) return errorResponse(400, "command is required");
    try {
      const id = sessionId ? `task_${randomUUID()}` : undefined;
      const manager = getTaskManager({ cwd, ...(sessionId ? { sessionId } : {}) });
      const task = await manager.createShellTask({
        ...(id ? { id } : {}),
        command,
        description: command,
        cwd,
        ...(sessionId ? { sessionId } : {}),
      });
      if (sessionId) {
        const before = this.latestEventSeq();
        this.store.createSessionTask({
          id: task.id,
          sessionId,
          type: task.type,
          description: task.description,
          cwd: task.cwd,
          metadata: { origin: "http", taskManagerId: task.id },
        });
        this.trackTask(manager, task.id);
        this.syncPersistentTask(task, manager);
        this.broadcastSince(before);
      }
      return jsonResponse({ task }, 201);
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }
  }

  private handleGetTask(c: Context): Response {
    const taskId = c.req.param("taskId");
    if (!taskId) return errorResponse(400, "taskId is required");
    const scope = this.resolveTaskScope(c);
    if (scope instanceof Response) return scope;
    const manager = getTaskManager(scope);
    if (scope.sessionId) {
      this.projectManagerTasks(scope.sessionId, manager);
      const task = this.store.getSessionTask(taskId);
      if (!task || task.sessionId !== scope.sessionId) return errorResponse(404, `Task not found: ${taskId}`);
      const managerTaskId = typeof task.metadata.taskManagerId === "string" ? task.metadata.taskManagerId : task.id;
      let output = task.output;
      try { output = manager.readTaskOutput(managerTaskId); } catch { /* durable state remains available after restart */ }
      return jsonResponse({ task, ...(output !== undefined ? { output } : {}) });
    }
    const task = manager.getTask(taskId);
    if (!task) return errorResponse(404, `Task not found: ${taskId}`);
    let output: string | undefined;
    try {
      output = manager.readTaskOutput(taskId);
    } catch {
      output = undefined;
    }
    return jsonResponse({ task, ...(output !== undefined ? { output } : {}) });
  }

  private async handleStopTask(c: Context): Promise<Response> {
    const taskId = c.req.param("taskId");
    if (!taskId) return errorResponse(400, "taskId is required");
    const scope = this.resolveTaskScope(c);
    if (scope instanceof Response) return scope;
    try {
      const manager = getTaskManager(scope);
      if (scope.sessionId) this.projectManagerTasks(scope.sessionId, manager);
      const persisted = scope.sessionId ? this.store.getSessionTask(taskId) : undefined;
      const managerTaskId = persisted && typeof persisted.metadata.taskManagerId === "string"
        ? persisted.metadata.taskManagerId
        : taskId;
      const task = await manager.stopTask(managerTaskId);
      if (scope.sessionId && persisted) {
        this.syncPersistentTask(task, manager, persisted.id);
      }
      return jsonResponse({ task });
    } catch (error) {
      return errorResponse(404, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleGetSessionMcp(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const session = this.store.getSession(sessionId);
    if (!session) return errorResponse(404, "Session not found");
    try {
      await this.warmRuntime(sessionId);
      const runtime = this.runtimes.get(sessionId) ? await this.runtimes.get(sessionId)! : undefined;
      if (!runtime?.inspect) return jsonResponse({ servers: [] as unknown[] });
      const inspect = await runtime.inspect();
      return jsonResponse({ servers: inspect.mcpServers });
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private handleListSessions(c: Context): Response {
    let sessions = this.store.listSessions({
      cwd: c.req.query("cwd") ?? undefined,
      includeArchived: c.req.query("includeArchived") === "true",
      limit: readLimit(c.req.query("limit")),
    });
    if (c.req.query("includeChildren") !== "true") {
      sessions = sessions.filter((session) => !session.parentId);
    }
    sessions = sessions.map((session) => ({
      ...session,
      title: this.store.resolveSessionListTitle(session.id),
    }));
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

  private async createChildSession(
    input: Parameters<ChildSessionHost["createChildSession"]>[0],
  ): ReturnType<ChildSessionHost["createChildSession"]> {
    if (!this.store.getSession(input.parentId)) {
      throw new Error(`Parent session not found: ${input.parentId}`);
    }
    const parent = this.store.getSession(input.parentId)!;
    const before = this.latestEventSeq();
    const session = this.store.createSession({
      ...input,
      model: input.model ?? parent.model,
    });
    this.broadcastSince(before);
    await this.warmRuntime(session.id);
    return session;
  }

  private async awaitChildRun(
    sessionId: string,
    runId: string,
  ): ReturnType<ChildSessionHost["awaitRun"]> {
    const initial = this.store.getRun(runId);
    if (!initial || initial.sessionId !== sessionId) throw new Error(`Session run not found: ${runId}`);
    if (initial.status === "pending" || initial.status === "running") {
      await this.runPromises.get(runId);
    }
    const run = this.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) throw new Error(`Session run not found: ${runId}`);
    if (run.status === "pending" || run.status === "running") {
      throw new Error(`Session run is still active: ${runId}`);
    }
    const output = this.store.listMessages(sessionId)
      .filter((message) => message.runId === runId && message.role === "assistant")
      .flatMap((message) => this.store.listMessageParts(sessionId, { messageId: message.id }))
      .map((part) => {
        if (part.text) return part.text;
        if (part.output == null) return "";
        return typeof part.output === "string" ? part.output : JSON.stringify(part.output);
      })
      .filter(Boolean)
      .join("\n");
    return {
      status: run.status,
      output,
      ...(run.error ? { error: run.error } : {}),
    };
  }

  private handleGetSession(c: Context): Response {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const session = this.store.getSession(sessionId);
    if (!session) return errorResponse(404, "Session not found");
    void this.warmRuntime(sessionId);
    return jsonResponse({ session });
  }

  private async handleUpdateSession(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const before = this.latestEventSeq();
    const body = await readJson(c);
    try {
      const existing = this.store.getSession(sessionId);
      if (!existing) return errorResponse(404, "Session not found");
      const nextMetadata = isRecord(body.metadata)
        ? { ...existing.metadata, ...body.metadata }
        : undefined;
      const runtimeMetadataChanged = nextMetadata && runtimeSessionMetadataChanged(existing.metadata, nextMetadata);
      if (runtimeMetadataChanged && this.runCoordinator.hasWork(sessionId)) {
        return errorResponse(409, "Cannot update runtime session settings while a run is active");
      }
      const session = this.store.updateSession(sessionId, {
        title: typeof body.title === "string" ? body.title : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
        agent: body.agent === null ? null : typeof body.agent === "string" ? body.agent : undefined,
        metadata: nextMetadata,
      });
      if (runtimeMetadataChanged) {
        await this.closeRuntime(sessionId);
      }
      this.broadcastSince(before);
      return jsonResponse({ session });
    } catch (error) {
      return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
    }
  }

  private handleGetSessionState(c: Context): Response {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    try {
      return jsonResponse(this.store.getSessionState(sessionId));
    } catch (error) {
      return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
    }
  }

  private async handleArchiveSession(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    try {
      const session = await this.archiveSessionTree(sessionId);
      return jsonResponse({ session });
    } catch (error) {
      return errorResponse(404, error instanceof Error ? error.message : String(error));
    }
  }

  private async archiveSessionTree(sessionId: string): Promise<ReturnType<SessionStore["archiveSession"]>> {
    const existing = this.archivePromises.get(sessionId);
    if (existing) return await existing;
    const archive = this.archiveSessionTreeWork(sessionId).finally(() => {
      if (this.archivePromises.get(sessionId) === archive) this.archivePromises.delete(sessionId);
    });
    this.archivePromises.set(sessionId, archive);
    return await archive;
  }

  private async archiveSessionTreeWork(sessionId: string): Promise<ReturnType<SessionStore["archiveSession"]>> {
    const children = this.store.listChildSessions(sessionId);
    for (const child of children) await this.archiveSessionTree(child.id);

    const beforeClosing = this.latestEventSeq();
    const current = this.store.getSession(sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    if (current.status === "archived") return current;
    this.store.beginArchive(sessionId);
    this.broadcastSince(beforeClosing);
    const interrupted = this.interruptSession(sessionId);
    const interruptedRunIds = [interrupted.activeRunId, ...interrupted.queuedRunIds]
      .filter((runId): runId is string => !!runId);
    await Promise.all(interruptedRunIds
      .map((runId) => this.runPromises.get(runId))
      .filter((promise): promise is Promise<void> => promise !== undefined));
    await this.closeRuntime(sessionId);
    const before = this.latestEventSeq();
    const session = this.store.archiveSession(sessionId);
    this.broadcastSince(before);
    return session;
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
    const body = await readJson(c);
    if (typeof body.content !== "string") return errorResponse(400, "content is required");

    try {
      const admitted = this.admitPromptAndMaybeRun(sessionId, {
        id: typeof body.id === "string" ? body.id : undefined,
        delivery: body.delivery === "steer" ? "steer" : "queue",
        content: body.content,
        metadata: isRecord(body.metadata) ? body.metadata : undefined,
        traceId: this.traceIdForContext(c),
      });
      return jsonResponse(admitted, 202);
    } catch (error) {
      return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
    }
  }

  private async handleResumeInterruptedRun(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    if (!sessionId || !runId) return errorResponse(400, "sessionId and runId are required");
    const body = await readJson(c);
    if (body.id !== undefined && typeof body.id !== "string") return errorResponse(400, "id must be a string");
    if (body.metadata !== undefined && !isRecord(body.metadata)) return errorResponse(400, "metadata must be an object");

    const sourceRun = this.store.getRun(runId);
    if (!sourceRun || sourceRun.sessionId !== sessionId) return errorResponse(404, "Interrupted run not found");
    if (sourceRun.status !== "interrupted") return errorResponse(409, "Only interrupted runs can be resumed");
    if (!sourceRun.inputId) return errorResponse(409, "This interrupted run has no prompt to replay");
    const sourceInput = this.store.getInput(sourceRun.inputId);
    if (!sourceInput || sourceInput.sessionId !== sessionId) return errorResponse(409, "The original prompt is unavailable");

    const existingRecovery = this.store.listInputs(sessionId).find((input) =>
      isRecord(input.metadata.recovery) && input.metadata.recovery.sourceRunId === sourceRun.id,
    );
    if (existingRecovery && existingRecovery.id === body.id) {
      const existingRun = this.store.findRunByInput(existingRecovery.id);
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
    if (!this.runtimeFactory) return errorResponse(409, "Session runtime is unavailable");
    if (this.runCoordinator.hasWork(sessionId)) {
      return errorResponse(409, "Wait for the active session run before resuming interrupted work");
    }

    try {
      const resumed = this.admitPromptAndMaybeRun(sessionId, {
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
        traceId: this.traceIdForContext(c),
      });
      const beforeRecoveryEvent = this.latestEventSeq();
      this.store.appendEvent({
        type: "session.run.recovery_requested",
        sessionId,
        payload: {
          sourceRunId: sourceRun.id,
          sourceInputId: sourceInput.id,
          recoveryInputId: resumed.input.id,
          recoveryRunId: resumed.run?.id,
        },
      });
      this.broadcastSince(beforeRecoveryEvent);
      return jsonResponse({ ...resumed, source_run: sourceRun }, 202);
    } catch (error) {
      return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
    }
  }

  private async handleInvokeCommand(c: Context): Promise<Response> {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    const body = await readJson(c);
    const session = this.store.getSession(sessionId);
    if (!session) return errorResponse(404, "Session not found");

    let name = typeof body.name === "string" ? normalizeCommandName(body.name) : "";
    let args = typeof body.args === "string" ? body.args : "";
    if (!name && typeof body.line === "string") {
      const parsed = parseSlashLine(body.line);
      if (!parsed) return errorResponse(400, "line must be a slash command");
      name = parsed.name;
      args = parsed.args;
    }
    if (!name) return errorResponse(400, "name or line is required");

    if (!this.commandCatalog?.expand) {
      return errorResponse(400, "Command expansion is not available");
    }

    try {
      const expanded = await this.commandCatalog.expand({ cwd: session.cwd, name, args });
      if (!expanded) return errorResponse(404, `Unknown command: ${name}`);
      const admitted = this.admitPromptAndMaybeRun(sessionId, {
        content: expanded.prompt,
        metadata: {
          command: expanded.command.name,
          commandKind: expanded.command.kind,
          commandArgs: args,
        },
        traceId: this.traceIdForContext(c),
      });
      return jsonResponse({ ...admitted, command: expanded.command }, 202);
    } catch (error) {
      return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
    }
  }

  private admitPromptAndMaybeRun(
    sessionId: string,
    input: {
      id?: string;
      delivery?: "queue" | "steer";
      content: string;
      metadata?: Record<string, unknown>;
      runMetadata?: Record<string, unknown>;
      traceId?: string;
    },
  ): {
    input: ReturnType<SessionStore["admitPrompt"]>;
    run?: ReturnType<SessionStore["createRun"]>;
    queue_state?: "running" | "queued";
  } {
    const delivery = input.delivery ?? "queue";
    const traceId = normalizeTraceId(input.traceId) ?? normalizeTraceId(input.metadata?.traceId) ?? randomUUID();
    const metadata = { ...(input.metadata ?? {}), traceId };
    const runMetadata = { ...(input.runMetadata ?? {}), traceId };
    const existingInput = input.id ? this.store.getInput(input.id) : undefined;
    if (existingInput) {
      if (
        existingInput.sessionId !== sessionId ||
        existingInput.content !== input.content ||
        existingInput.delivery !== delivery ||
        !jsonEqual(withoutTraceId(existingInput.metadata), withoutTraceId(metadata))
      ) {
        throw new Error(`Prompt id is already used: ${input.id}`);
      }
      const existingRun = this.store.findRunByInput(existingInput.id);
      return {
        input: existingInput,
        ...(existingRun ? { run: existingRun } : {}),
        ...(existingRun?.status === "running" ? { queue_state: "running" as const } : {}),
        ...(existingRun?.status === "pending" ? { queue_state: "queued" as const } : {}),
      };
    }

    const before = this.latestEventSeq();
    const admitted = this.store.admitPrompt({
      id: input.id,
      sessionId,
      delivery,
      content: input.content,
      metadata,
    });

    if (delivery === "steer" && this.runtimeFactory) {
      const activeRunId = this.runCoordinator.activeRunId(sessionId);
      if (activeRunId) {
        this.broadcastSince(before);
        this.runCoordinator.mergeWake(sessionId);
        const activeRun = this.store.getRun(activeRunId);
        return {
          input: admitted,
          ...(activeRun ? { run: activeRun, queue_state: "running" as const } : {}),
        };
      }
    }

    const run = this.runtimeFactory
      ? this.store.createRun({ sessionId, inputId: admitted.id, metadata: runMetadata })
      : undefined;
    this.broadcastSince(before);
    let queueState: "running" | "queued" | undefined;
    if (run) {
      const enqueued = this.runCoordinator.enqueue({
        sessionId,
        runId: run.id,
        work: (context) => this.executeRun(sessionId, admitted.id, run.id, context),
      });
      queueState = enqueued.state;
      const tracked = enqueued.promise.catch(() => {
        // The persisted run state is updated by executeRun or interrupt handling.
      }).finally(() => {
        if (this.runPromises.get(run.id) === tracked) this.runPromises.delete(run.id);
      });
      this.runPromises.set(run.id, tracked);
    }
    return { input: admitted, ...(run ? { run, queue_state: queueState } : {}) };
  }

  private handleInterruptSession(c: Context): Response {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return errorResponse(400, "sessionId is required");
    return jsonResponse(this.interruptSession(sessionId));
  }

  private interruptSession(sessionId: string): ReturnType<SessionRunCoordinator["interrupt"]> {
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
    return result;
  }

  private hasAnyActiveRuns(): boolean {
    return this.store.listSessions({ includeArchived: true }).some((session) => this.runCoordinator.hasWork(session.id));
  }

  private hasActiveRunsForCwd(cwd: string): boolean {
    return this.store.listSessions({ cwd, includeArchived: true }).some((session) => this.runCoordinator.hasWork(session.id));
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
      const traceId = this.traceIdForRun(runId);

      this.store.updateRun(runId, { status: "running" });
      this.log({ level: "info", event: "session.run.started", traceId, sessionId, runId });
      const renderState = this.createRunRenderState(sessionId, inputId, runId, admitted.content);
      this.broadcastSince(before);

      const drainSteeredInputs = () => {
        const pending = this.store.listUnboundInputs(sessionId);
        if (pending.length === 0) return pending;
        const eventBefore = this.latestEventSeq();
        this.completeActiveTextPart(renderState, "completed");
        delete renderState.assistantMessageId;
        renderState.assistantTurnCompleted = true;
        for (const steered of pending) {
          const userMessage = this.store.createMessage({
            sessionId,
            role: "user",
            runId,
            inputId: steered.id,
          });
          this.store.upsertMessagePart({
            sessionId,
            messageId: userMessage.id,
            type: "text",
            status: "completed",
            text: steered.content,
          });
        }
        this.broadcastSince(eventBefore);
        return pending;
      };

      const runtime = await this.getOrCreateRuntime(session, history, parts);
      await runtime.runPrompt(
        {
          session,
          input: admitted,
          runId,
          history,
          parts,
          signal: context.signal,
          wakeCount: context.wakeCount,
          drainSteeredInputs,
        },
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
            const completedToolName = event.type === "tool_use_end"
              ? renderState.toolParts.get(event.toolUseId)?.toolName
              : undefined;
            this.applyStreamEvent(renderState, event);
            if (event.type === "tool_use_start") {
              this.log({
                level: "info",
                event: "session.tool.started",
                traceId,
                sessionId,
                runId,
                toolName: event.toolUse.name,
              });
            } else if (event.type === "tool_use_end") {
              this.log({
                level: event.result.isError ? "warn" : "info",
                event: "session.tool.completed",
                traceId,
                sessionId,
                runId,
                toolName: completedToolName,
                ...(event.result.isError ? { error: "tool returned an error" } : {}),
              });
            }
            this.broadcastSince(eventBefore);
          },
          askPermission: (request) =>
            this.permissionBroker.ask({
              sessionId,
              runId,
              traceId,
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
      this.log({
        level: context.signal.aborted ? "warn" : "info",
        event: context.signal.aborted ? "session.run.interrupted" : "session.run.completed",
        traceId,
        sessionId,
        runId,
      });
      this.broadcastSince(before);
    } catch (error) {
      await this.closeRuntime(sessionId);
      before = this.latestEventSeq();
      const message = error instanceof Error ? error.message : String(error);
      const traceId = this.traceIdForRun(runId);
      if (error instanceof RunInterruptedError || context.signal.aborted) {
        this.store.appendEvent({ type: "session.run.interrupted", sessionId, payload: { runId, traceId, error: message } });
        this.store.updateRun(runId, { status: "interrupted", error: message });
        this.log({ level: "warn", event: "session.run.interrupted", traceId, sessionId, runId, error: message });
      } else {
        this.store.appendEvent({ type: "session.run.error", sessionId, payload: { runId, traceId, error: message } });
        this.store.updateRun(runId, { status: "failed", error: message });
        this.log({ level: "error", event: "session.run.failed", traceId, sessionId, runId, error: message });
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

    const promise = this.runtimeFactory.createRuntime({
      session,
      history,
      parts,
      childSessionHost: this.childSessionHost,
      sessionTaskBridge: this.createSessionTaskBridge(session),
    }).catch((error) => {
      if (this.runtimes.get(session.id) === promise) this.runtimes.delete(session.id);
      throw error;
    });
    this.runtimes.set(session.id, promise);
    return await promise;
  }

  private createSessionTaskBridge(session: { id: string; cwd: string }): SessionTaskBridge {
    const manager = getTaskManager({ cwd: session.cwd, sessionId: session.id });
    return {
      registerSessionTask: (input) => {
        const task = manager.registerSessionTask({ ...input, id: `task_${randomUUID()}` });
        const before = this.latestEventSeq();
        this.store.createSessionTask({
          id: task.id,
          sessionId: input.sessionId,
          childSessionId: input.childSessionId,
          type: task.type,
          description: task.description,
          cwd: task.cwd,
          metadata: { origin: "child_session", agent: task.description, taskManagerId: task.id },
        });
        this.log({
          level: "info",
          event: "session.task.created",
          sessionId: input.sessionId,
          taskId: task.id,
        });
        this.broadcastSince(before);
        return { id: task.id };
      },
      bindSessionTaskRun: async (taskId, runId) => {
        const before = this.latestEventSeq();
        const task = this.store.updateSessionTask(taskId, { status: "running", runId });
        this.log({
          level: "info",
          event: "session.task.bound",
          traceId: this.traceIdForRun(runId),
          sessionId: task.sessionId,
          runId,
          taskId,
        });
        this.broadcastSince(before);
      },
      completeSessionTask: async (taskId, input) => {
        const managerStatus = input.status === "interrupted" ? "stopped" : input.status;
        const task = await manager.completeSessionTask(taskId, { ...input, status: managerStatus });
        const before = this.latestEventSeq();
        this.store.updateSessionTask(taskId, {
          status: input.status,
          output: input.output,
          ...(input.status === "failed" ? { error: input.output } : {}),
        });
        const persisted = this.store.getSessionTask(taskId);
        this.log({
          level: input.status === "failed" ? "error" : "info",
          event: "session.task.completed",
          ...(persisted?.runId ? { traceId: this.traceIdForRun(persisted.runId), runId: persisted.runId } : {}),
          sessionId: persisted?.sessionId ?? session.id,
          taskId,
          ...(input.status === "failed" ? { error: "task failed" } : {}),
        });
        this.broadcastSince(before);
        return task;
      },
      writeToSessionTask: async (taskId, data) => {
        await manager.writeToTask(taskId, data);
        const before = this.latestEventSeq();
        this.store.updateSessionTask(taskId, { status: "running" });
        this.broadcastSince(before);
      },
    };
  }

  private projectManagerTasks(sessionId: string, manager: ReturnType<typeof getTaskManager>): void {
    for (const task of manager.listTasks()) {
      const persisted = this.store.findSessionTaskByManagerTaskId(sessionId, task.id);
      if (!persisted) {
        const sameId = this.store.getSessionTask(task.id);
        this.store.createSessionTask({
          id: sameId && sameId.sessionId !== sessionId ? `task_${randomUUID()}` : task.id,
          sessionId,
          childSessionId: typeof task.metadata.child_session_id === "string" ? task.metadata.child_session_id : undefined,
          type: task.type,
          description: task.description,
          cwd: task.cwd,
          metadata: { origin: "task_manager", taskManagerId: task.id },
        });
      }
      const durableTask = this.store.findSessionTaskByManagerTaskId(sessionId, task.id) ?? this.store.getSessionTask(task.id);
      if (durableTask?.sessionId === sessionId) this.syncPersistentTask(task, manager, durableTask.id);
    }
  }

  private trackTask(manager: ReturnType<typeof getTaskManager>, taskId: string): void {
    manager.registerTaskListener((task) => {
      if (task.id !== taskId) return;
      const persisted = this.store.getSessionTask(taskId);
      if (!persisted) return;
      this.syncPersistentTask(task, manager, persisted.id);
    });
  }

  private syncPersistentTask(
    task: TaskInfo,
    manager: ReturnType<typeof getTaskManager>,
    durableTaskId = task.id,
  ): void {
    const status = task.status === "pending" || task.status === "running" || task.status === "completed" ||
      task.status === "failed" || task.status === "stopped" ? task.status : "failed";
    let output: string | undefined;
    try { output = manager.readTaskOutput(task.id); } catch { /* output is optional */ }
    const before = this.latestEventSeq();
    this.store.updateSessionTask(durableTaskId, {
      status,
      ...(output !== undefined ? { output } : {}),
      ...(status === "failed" ? { error: output ?? "Task failed" } : {}),
    });
    this.broadcastSince(before);
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

  /**
   * Session runs and TaskManager ownership die with the daemon process. Workflow
   * snapshots are project-local, so reconcile only run ids that this session log
   * proves were started by this daemon; unrelated CLI/project workflows are left alone.
   */
  private async recoverInterruptedWorkflows(): Promise<void> {
    const ownedRuns = new Map<string, { sessionId: string; cwd: string }>();
    for (const event of this.store.listEvents()) {
      if (event.type !== "workflow.workflow_started" || !event.sessionId) continue;
      const runId = workflowRunIdFromSessionEvent(event);
      if (!runId) continue;
      const session = this.store.getSession(event.sessionId);
      if (session) ownedRuns.set(runId, { sessionId: session.id, cwd: session.cwd });
    }

    for (const [runId, owner] of ownedRuns) {
      const workflowStore = new WorkflowRunStore({ cwd: owner.cwd });
      let snapshot;
      try {
        snapshot = workflowStore.load(runId);
      } catch (error) {
        this.appendWorkflowRecoveryFailure(owner.sessionId, runId, error);
        continue;
      }
      if (!snapshot || snapshot.status !== "running") continue;

      const before = this.latestEventSeq();
      await cancelPersistentWorkflow(snapshot, {
        store: workflowStore,
        reason: DAEMON_RESTART_WORKFLOW_REASON,
        onEvent: (event: WorkflowRunEvent) => this.appendWorkflowRecoveryEvent(owner.sessionId, event),
      });
      this.broadcastSince(before);
    }
  }

  private appendWorkflowRecoveryEvent(sessionId: string, event: WorkflowRunEvent): void {
    this.store.appendEvent({
      type: `workflow.${event.type}`,
      sessionId,
      payload: { event, recoveredAfterDaemonRestart: true },
    });
  }

  private appendWorkflowRecoveryFailure(sessionId: string, runId: string, error: unknown): void {
    this.store.appendEvent({
      type: "workflow.workflow_recovery_failed",
      sessionId,
      payload: {
        runId,
        error: error instanceof Error ? error.message : String(error),
        recoveredAfterDaemonRestart: true,
      },
    });
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
        traceId: this.traceIdForContext(c),
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
        const heartbeat = setInterval(() => this.writeSseComment(client!, "keepalive"), 15_000);
        heartbeat.unref?.();
        client.heartbeat = heartbeat;
        for (const event of this.store.listEvents({ afterSeq: readEventCursor(c), sessionId })) {
          this.writeSse(client, event);
        }
      },
      cancel: () => {
        if (client) this.removeSseClient(client);
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
      this.removeSseClient(client);
    }
  }

  private writeSseComment(client: SseClient, comment: string): void {
    try {
      client.controller.enqueue(this.encoder.encode(`: ${comment}\n\n`));
    } catch {
      this.removeSseClient(client);
    }
  }

  private removeSseClient(client: SseClient): void {
    if (client.heartbeat) clearInterval(client.heartbeat);
    this.sseClients.delete(client);
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
