import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";

import type { StreamEvent } from "@openharness/core";
import {
  SessionStore,
  getTaskManager,
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

export interface OpenHarnessServerOptions {
  host?: string;
  port?: number;
  token?: string;
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
  private readonly permissionBroker: StorePermissionBroker;
  private readonly childSessionHost: ChildSessionHost;
  private readonly runCoordinator = new SessionRunCoordinator();
  private readonly encoder = new TextEncoder();
  private readonly sseClients = new Set<SseClient>();
  private readonly runtimes = new Map<string, Promise<SessionRuntime>>();
  private readonly runPromises = new Map<string, Promise<void>>();
  private listener?: Listener;
  private listenResult?: ListenResult;

  constructor(options: OpenHarnessServerOptions = {}) {
    this.app = new Hono();
    this.store = options.store ?? new SessionStore({ path: options.storePath ?? getDefaultSessionStorePath() });
    this.store.interruptActiveRuns();
    this.token = options.token;
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
    this.permissionBroker = new StorePermissionBroker({
      store: this.store,
      onChange: (previousEventSeq) => this.broadcastSince(previousEventSeq),
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
    if (this.store.listRuns(sessionId).some((run) => run.status === "running" || run.status === "pending")) {
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
    if (this.store.listRuns(sessionId).some((run) => run.status === "running" || run.status === "pending")) {
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
      const task = await getTaskManager({ cwd, ...(sessionId ? { sessionId } : {}) }).createShellTask({
        command,
        description: command,
        cwd,
        ...(sessionId ? { sessionId } : {}),
      });
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
      const task = await getTaskManager(scope).stopTask(taskId);
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
    const sessions = this.store.listSessions({
      cwd: c.req.query("cwd") ?? undefined,
      includeArchived: c.req.query("includeArchived") === "true",
      limit: readLimit(c.req.query("limit")),
    }).map((session) => ({
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
      const session = this.store.updateSession(sessionId, {
        title: typeof body.title === "string" ? body.title : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
        agent: body.agent === null ? null : typeof body.agent === "string" ? body.agent : undefined,
        metadata: isRecord(body.metadata) ? body.metadata : undefined,
      });
      this.broadcastSince(before);
      return jsonResponse({ session });
    } catch (error) {
      return errorResponse(404, error instanceof Error ? error.message : String(error));
    }
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
    const children = this.store.listChildSessions(sessionId);
    for (const child of children) await this.archiveSessionTree(child.id);

    this.interruptSession(sessionId);
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
      });
      return jsonResponse(admitted, 202);
    } catch (error) {
      return errorResponse(404, error instanceof Error ? error.message : String(error));
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
      });
      return jsonResponse({ ...admitted, command: expanded.command }, 202);
    } catch (error) {
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private admitPromptAndMaybeRun(
    sessionId: string,
    input: {
      id?: string;
      delivery?: "queue" | "steer";
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): {
    input: ReturnType<SessionStore["admitPrompt"]>;
    run?: ReturnType<SessionStore["createRun"]>;
    queue_state?: "running" | "queued";
  } {
    const before = this.latestEventSeq();
    const delivery = input.delivery ?? "queue";
    const admitted = this.store.admitPrompt({
      id: input.id,
      sessionId,
      delivery,
      content: input.content,
      metadata: input.metadata,
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
      ? this.store.createRun({ sessionId, inputId: admitted.id })
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

    const promise = this.runtimeFactory.createRuntime({
      session,
      history,
      parts,
      childSessionHost: this.childSessionHost,
    }).catch((error) => {
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
