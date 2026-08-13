/**
 * daemon HTTP/SSE 客户端。
 *
 * 包装 `@openharness/server` 的 REST 路由与 `/events/stream` SSE；
 * 不含本地状态归并（见 `reducer.ts` / `sync.ts`）。
 */

import type {
  AdmitClientPromptInput,
  CommandCatalogEntry,
  CreateClientSessionInput,
  EventSyncOptions,
  InterruptSessionResponse,
  InvokeClientCommandInput,
  InvokeCommandResponse,
  ListClientMessagePartsOptions,
  ListCommandsOptions,
  ListEventsOptions,
  ListMessagesOptions,
  ListPermissionsOptions,
  ListSessionsOptions,
  AgentPersonaInfo,
  AuthStatus,
  CompactSessionResponse,
  CronJobRecord,
  CronRunRecord,
  CronStatus,
  CreateTaskInput,
  HookInfo,
  ReloadPluginsResponse,
  RewindSessionResponse,
  ListTasksOptions,
  McpServerStatus,
  MemoryEntryRecord,
  MemoryListResponse,
  ModelProviderInfo,
  OpenHarnessClientOptions,
  OpenHarnessServerHealth,
  PermissionRequestRecord,
  PluginInfo,
  PromptResponse,
  ResumeInterruptedRunInput,
  ResumeInterruptedRunResponse,
  ProviderInfo,
  OutputStyleInfo,
  RememberSessionResponse,
  SaveCronJobInput,
  ReplyPermissionInput,
  SessionEventRecord,
  SessionExportResponse,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionStateSnapshot,
  SessionUsageResponse,
  StartDreamResponse,
  TaskSnapshot,
  UpdateClientSessionInput,
} from "../types/index.js";

let promptRequestCounter = 0;

/** Normalize a daemon base URL without accepting credentials or request fragments. */
export function normalizeDaemonBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("Daemon URL is required");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Daemon URL must be an absolute http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Daemon URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Daemon URL must not contain credentials; use a bearer token instead");
  }
  if (url.search || url.hash) {
    throw new Error("Daemon URL must not contain query parameters or a fragment");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

/** Generate a caller-stable id for one prompt admission attempt. */
export function createPromptRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  promptRequestCounter += 1;
  return `prompt-${Date.now().toString(36)}-${promptRequestCounter.toString(36)}`;
}

/** HTTP API 非 2xx 时抛出；携带 status 与原始响应体。 */
export class OpenHarnessApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "OpenHarnessApiError";
  }
}

/**
 * 面向 daemon 的 typed fetch 客户端。
 * 构造时传入 `baseUrl` 与可选 Bearer `token`（通常来自 daemon registry）。
 */
export class OpenHarnessClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenHarnessClientOptions) {
    this.baseUrl = normalizeDaemonBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** `GET /health` */
  async health(options: { signal?: AbortSignal } = {}): Promise<OpenHarnessServerHealth> {
    return this.request<OpenHarnessServerHealth>("/health", { auth: false, signal: options.signal });
  }

  /** `GET /commands?cwd=` — cwd-scoped slash command catalog for autocomplete. */
  async listCommands(options: ListCommandsOptions & { signal?: AbortSignal }): Promise<CommandCatalogEntry[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ commands: CommandCatalogEntry[] }>(this.path("/commands", query), { signal });
    return response.commands;
  }

  /** `GET /settings` */
  async getSettings(options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const response = await this.request<{ settings: Record<string, unknown> }>("/settings", { signal: options.signal });
    return response.settings;
  }

  /** `PATCH /settings` */
  async patchSettings(
    patch: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request<{ settings: Record<string, unknown> }>("/settings", {
      method: "PATCH",
      body: patch,
      signal: options.signal,
    });
    return response.settings;
  }

  /** `GET /providers` */
  async listProviders(options: { signal?: AbortSignal } = {}): Promise<ProviderInfo[]> {
    const response = await this.request<{ providers: ProviderInfo[] }>("/providers", { signal: options.signal });
    return response.providers;
  }

  /** `GET /models` */
  async listModels(options: { signal?: AbortSignal } = {}): Promise<ModelProviderInfo[]> {
    const response = await this.request<{ providers: ModelProviderInfo[] }>("/models", { signal: options.signal });
    return response.providers;
  }

  /** `GET /tasks` */
  async listTasks(options: ListTasksOptions & { signal?: AbortSignal } = {}): Promise<TaskSnapshot[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ tasks: TaskSnapshot[] }>(this.path("/tasks", query), { signal });
    return response.tasks;
  }

  /** `GET /tasks/:id` */
  async getTask(
    taskId: string,
    options: ListTasksOptions & { signal?: AbortSignal } = {},
  ): Promise<{ task: TaskSnapshot; output?: string }> {
    const { signal, ...query } = options;
    return await this.request<{ task: TaskSnapshot; output?: string }>(
      this.path(`/tasks/${encodeURIComponent(taskId)}`, query),
      { signal },
    );
  }

  /** `POST /tasks/:id/stop` */
  async stopTask(
    taskId: string,
    options: ListTasksOptions & { signal?: AbortSignal } = {},
  ): Promise<TaskSnapshot> {
    const { signal, ...query } = options;
    const response = await this.request<{ task: TaskSnapshot }>(
      this.path(`/tasks/${encodeURIComponent(taskId)}/stop`, query),
      { method: "POST", signal },
    );
    return response.task;
  }

  /** `POST /tasks` */
  async createTask(
    input: CreateTaskInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<TaskSnapshot> {
    const response = await this.request<{ task: TaskSnapshot }>("/tasks", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return response.task;
  }

  /** `GET /sessions/:id/mcp` */
  async getSessionMcp(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<McpServerStatus[]> {
    const response = await this.request<{ servers: McpServerStatus[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/mcp`,
      { signal: options.signal },
    );
    return response.servers;
  }

  /** `GET /memory?cwd=` */
  async listMemory(options: { cwd: string; signal?: AbortSignal }): Promise<MemoryListResponse> {
    const { signal, ...query } = options;
    return await this.request<MemoryListResponse>(this.path("/memory", query), { signal });
  }

  /** `GET /memory/:id?cwd=` */
  async getMemory(
    entryId: string,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<MemoryEntryRecord> {
    const { signal, cwd } = options;
    const response = await this.request<{ entry: MemoryEntryRecord }>(
      this.path(`/memory/${encodeURIComponent(entryId)}`, { cwd }),
      { signal },
    );
    return response.entry;
  }

  /** `POST /memory` */
  async addMemory(
    input: { cwd: string; content: string; tags?: string[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<MemoryEntryRecord> {
    const response = await this.request<{ entry: MemoryEntryRecord }>("/memory", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return response.entry;
  }

  /** `DELETE /memory/:id?cwd=` */
  async removeMemory(
    entryId: string,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<void> {
    const { signal, cwd } = options;
    await this.request<{ deleted: boolean }>(
      this.path(`/memory/${encodeURIComponent(entryId)}`, { cwd }),
      { method: "DELETE", signal },
    );
  }

  /** `GET /auth` */
  async getAuthStatus(options: { signal?: AbortSignal } = {}): Promise<AuthStatus> {
    const response = await this.request<{ auth: AuthStatus }>("/auth", { signal: options.signal });
    return response.auth;
  }

  /** `POST /auth/login` */
  async authLogin(
    input: { provider: string; apiKey?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>("/auth/login", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `POST /auth/logout` */
  async authLogout(
    input: { provider: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>("/auth/logout", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `GET /context?cwd=` */
  async getContextPreview(options: { cwd: string; signal?: AbortSignal }): Promise<string> {
    const { signal, ...query } = options;
    const response = await this.request<{ report: string }>(this.path("/context", query), { signal });
    return response.report;
  }

  /** `POST /sessions/:id/compact` */
  async compactSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<CompactSessionResponse> {
    return await this.request<CompactSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/compact`,
      { method: "POST", signal: options.signal },
    );
  }

  /** `POST /sessions/:id/rewind` */
  async rewindSession(
    sessionId: string,
    input: { count?: number } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<RewindSessionResponse> {
    return await this.request<RewindSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/rewind`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** `POST /sessions/:id/remember` */
  async rememberSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RememberSessionResponse> {
    return await this.request<RememberSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/remember`,
      { method: "POST", signal: options.signal },
    );
  }

  /** `POST /dream` */
  async startDream(
    input: { cwd: string; sessionId?: string; preview?: boolean },
    options: { signal?: AbortSignal } = {},
  ): Promise<StartDreamResponse> {
    return await this.request<StartDreamResponse>("/dream", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `GET /profile` */
  async getProfileStatus(options: { signal?: AbortSignal } = {}): Promise<string> {
    const response = await this.request<{ report: string }>("/profile", { signal: options.signal });
    return response.report;
  }

  /** `POST /profile/init` */
  async initProfile(options: { signal?: AbortSignal } = {}): Promise<string> {
    const response = await this.request<{ report: string }>("/profile/init", {
      method: "POST",
      signal: options.signal,
    });
    return response.report;
  }

  /** `GET /output-styles` */
  async listOutputStyles(options: { signal?: AbortSignal } = {}): Promise<OutputStyleInfo[]> {
    const response = await this.request<{ styles: OutputStyleInfo[] }>("/output-styles", {
      signal: options.signal,
    });
    return response.styles;
  }

  /** `POST /project/init` */
  async initProject(
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.request<{ report: string }>("/project/init", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return response.report;
  }

  /** `GET /plugins?cwd=` */
  async listPlugins(options: { cwd: string; signal?: AbortSignal }): Promise<{
    plugins: PluginInfo[];
    warnings: string[];
  }> {
    const { signal, ...query } = options;
    return await this.request<{ plugins: PluginInfo[]; warnings: string[] }>(
      this.path("/plugins", query),
      { signal },
    );
  }

  /** `POST /plugins/:name/enable` */
  async enablePlugin(
    name: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>(
      `/plugins/${encodeURIComponent(name)}/enable`,
      { method: "POST", signal: options.signal },
    );
  }

  /** `POST /plugins/:name/disable` */
  async disablePlugin(
    name: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>(
      `/plugins/${encodeURIComponent(name)}/disable`,
      { method: "POST", signal: options.signal },
    );
  }

  /** `POST /plugins/reload` */
  async reloadPlugins(
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<ReloadPluginsResponse> {
    return await this.request<ReloadPluginsResponse>("/plugins/reload", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `GET /agent-personas` */
  async listAgentPersonas(options: { signal?: AbortSignal } = {}): Promise<AgentPersonaInfo[]> {
    const response = await this.request<{ agents: AgentPersonaInfo[] }>("/agent-personas", {
      signal: options.signal,
    });
    return response.agents;
  }

  /** `GET /hooks?cwd=&sessionId=` */
  async listHooks(options: {
    cwd: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<HookInfo[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ hooks: HookInfo[] }>(this.path("/hooks", query), { signal });
    return response.hooks;
  }

  /** `GET /git/diff?cwd=&full=` */
  async getGitDiff(options: {
    cwd: string;
    full?: boolean;
    signal?: AbortSignal;
  }): Promise<string> {
    const { signal, cwd, full } = options;
    const response = await this.request<{ output: string }>(
      this.path("/git/diff", { cwd, ...(full ? { full: "true" } : {}) }),
      { signal },
    );
    return response.output;
  }

  /** `GET /git/branch?cwd=&list=` */
  async getGitBranch(options: {
    cwd: string;
    list?: boolean;
    signal?: AbortSignal;
  }): Promise<string> {
    const { signal, cwd, list } = options;
    const response = await this.request<{ output: string }>(
      this.path("/git/branch", { cwd, ...(list ? { list: "true" } : {}) }),
      { signal },
    );
    return response.output;
  }

  /** `GET /git/status?cwd=` */
  async getGitStatus(options: { cwd: string; signal?: AbortSignal }): Promise<string> {
    const { signal, cwd } = options;
    const response = await this.request<{ output: string }>(
      this.path("/git/status", { cwd }),
      { signal },
    );
    return response.output;
  }

  /** `POST /git/commit` */
  async gitCommit(
    input: { cwd: string; message: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.request<{ output: string }>("/git/commit", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return response.output;
  }

  /** `GET /sessions/:id/usage` */
  async getSessionUsage(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionUsageResponse> {
    return await this.request<SessionUsageResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/usage`,
      { signal: options.signal },
    );
  }

  /** `POST /sessions/:id/export` */
  async exportSession(
    sessionId: string,
    input: { filename?: string; json?: boolean } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionExportResponse> {
    return await this.request<SessionExportResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/export`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** `GET /sessions` */
  async listSessions(options: ListSessionsOptions & { signal?: AbortSignal } = {}): Promise<SessionRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ sessions: SessionRecord[] }>(this.path("/sessions", query), { signal });
    return response.sessions;
  }

  /** `POST /sessions` */
  async createSession(input: CreateClientSessionInput, options: { signal?: AbortSignal } = {}): Promise<SessionRecord> {
    const response = await this.request<{ session: SessionRecord }>("/sessions", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return response.session;
  }

  /** `GET /sessions/:id` */
  async getSession(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<SessionRecord> {
    const response = await this.request<{ session: SessionRecord }>(`/sessions/${encodeURIComponent(sessionId)}`, {
      signal: options.signal,
    });
    return response.session;
  }

  /** `GET /sessions/:id/state` - atomic attach snapshot plus SSE cursor. */
  async getSessionState(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<SessionStateSnapshot> {
    return await this.request<SessionStateSnapshot>(`/sessions/${encodeURIComponent(sessionId)}/state`, {
      signal: options.signal,
    });
  }

  /** `DELETE /sessions/:id` */
  async archiveSession(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<SessionRecord> {
    const response = await this.request<{ session: SessionRecord }>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      signal: options.signal,
    });
    return response.session;
  }

  /** `PATCH /sessions/:id` - update title, agent, or metadata.runtime fields. */
  async updateSession(
    sessionId: string,
    input: UpdateClientSessionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.request<{ session: SessionRecord }>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: input,
      signal: options.signal,
    });
    return response.session;
  }

  /** `GET /sessions/:id/messages` */
  async listMessages(
    sessionId: string,
    options: ListMessagesOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionMessageRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ messages: SessionMessageRecord[] }>(
      this.path(`/sessions/${encodeURIComponent(sessionId)}/messages`, query),
      { signal },
    );
    return response.messages;
  }

  /** `GET /sessions/:id/parts` */
  async listMessageParts(
    sessionId: string,
    options: ListClientMessagePartsOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionMessagePartRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ parts: SessionMessagePartRecord[] }>(
      this.path(`/sessions/${encodeURIComponent(sessionId)}/parts`, query),
      { signal },
    );
    return response.parts;
  }

  /** `POST /sessions/:id/prompts` — 提交用户输入并触发/排队一次 run。 */
  async admitPrompt(
    sessionId: string,
    input: AdmitClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PromptResponse> {
    return await this.request<PromptResponse>(`/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      method: "POST",
      body: { ...input, id: input.id ?? createPromptRequestId() },
      signal: options.signal,
    });
  }

  /**
   * `POST /sessions/:id/runs/:runId/resume` — 显式重放一次中断 run 的原始 prompt。
   * 不会继续旧 provider stream；服务端会创建一个带恢复溯源的新 input/run。
   */
  async resumeInterruptedRun(
    sessionId: string,
    runId: string,
    input: ResumeInterruptedRunInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<ResumeInterruptedRunResponse> {
    return await this.request<ResumeInterruptedRunResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/resume`,
      {
        method: "POST",
        body: { ...input, id: input.id ?? createPromptRequestId() },
        signal: options.signal,
      },
    );
  }

  /**
   * `POST /sessions/:id/commands` — expand a template/skill command into a prompt
   * and admit it through the normal run path. Not a generic slash executor.
   */
  async invokeCommand(
    sessionId: string,
    input: InvokeClientCommandInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<InvokeCommandResponse> {
    return await this.request<InvokeCommandResponse>(`/sessions/${encodeURIComponent(sessionId)}/commands`, {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `POST /sessions/:id/interrupt` — 中断当前/排队中的 run。 */
  async interruptSession(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<InterruptSessionResponse> {
    return await this.request<InterruptSessionResponse>(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
      signal: options.signal,
    });
  }

  /** `GET /events` — 用于 attach 时的历史 replay。 */
  async listEvents(options: ListEventsOptions & { signal?: AbortSignal } = {}): Promise<SessionEventRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ events: SessionEventRecord[] }>(this.path("/events", query), { signal });
    return response.events;
  }

  /** `GET /permissions` */
  async listPermissions(
    options: ListPermissionsOptions & { signal?: AbortSignal } = {},
  ): Promise<PermissionRequestRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ requests: PermissionRequestRecord[] }>(
      this.path("/permissions", query),
      { signal },
    );
    return response.requests;
  }

  /** `POST /permissions/:id/reply` — 批准/拒绝工具权限请求。 */
  async replyPermission(
    requestId: string,
    input: ReplyPermissionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PermissionRequestRecord> {
    const response = await this.request<{ request: PermissionRequestRecord }>(
      `/permissions/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.request;
  }

  /** `GET /events/stream` — SSE 实时事件流；`cursor` 之后的增量。 */
  async getCronStatus(options: { signal?: AbortSignal } = {}): Promise<CronStatus> {
    return await this.request<CronStatus>("/cron/status", { signal: options.signal });
  }

  async listCronJobs(options: { signal?: AbortSignal } = {}): Promise<CronJobRecord[]> {
    const response = await this.request<{ jobs: CronJobRecord[] }>("/cron/jobs", { signal: options.signal });
    return response.jobs;
  }

  async saveCronJob(
    name: string,
    input: SaveCronJobInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CronJobRecord> {
    const response = await this.request<{ job: CronJobRecord }>(`/cron/jobs/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: input,
      signal: options.signal,
    });
    return response.job;
  }

  async removeCronJob(name: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.request<{ removed: true }>(`/cron/jobs/${encodeURIComponent(name)}`, {
      method: "DELETE",
      signal: options.signal,
    });
  }

  async setCronJobEnabled(
    name: string,
    enabled: boolean,
    options: { signal?: AbortSignal } = {},
  ): Promise<CronJobRecord> {
    const response = await this.request<{ job: CronJobRecord }>(`/cron/jobs/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: { enabled },
      signal: options.signal,
    });
    return response.job;
  }

  async triggerCronJob(name: string, options: { signal?: AbortSignal } = {}): Promise<CronRunRecord> {
    const response = await this.request<{ run: CronRunRecord }>(`/cron/jobs/${encodeURIComponent(name)}/run`, {
      method: "POST",
      signal: options.signal,
    });
    return response.run;
  }

  async listCronRuns(
    options: { name?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<CronRunRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ runs: CronRunRecord[] }>(this.path("/cron/runs", query), { signal });
    return response.runs;
  }

  streamEvents(options: EventSyncOptions = {}): AsyncIterable<SessionEventRecord> {
    return streamServerSentEvents(async () => {
      const query = {
        cursor: options.cursor,
        sessionId: options.sessionId,
      };
      const response = await this.fetchImpl(`${this.baseUrl}${this.path("/events/stream", query)}`, {
        headers: this.headers(),
        signal: options.signal,
      });
      if (!response.ok) await this.throwResponseError(response);
      if (!response.body) throw new Error("Event stream response has no body");
      return response.body;
    });
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal; auth?: boolean } = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: this.headers(options.body !== undefined, options.auth ?? true),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    if (!response.ok) await this.throwResponseError(response);
    return await response.json() as T;
  }

  private headers(json = false, auth = true): Record<string, string> {
    return {
      ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  /** 拼 query；跳过 undefined / null / false。 */
  private path(pathname: string, query: Record<string, unknown> = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === false) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  private async throwResponseError(response: Response): Promise<never> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => "");
    }
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `OpenHarness API request failed with ${response.status}`;
    throw new OpenHarnessApiError(message, response.status, body);
  }
}

/**
 * 将 SSE 字节流解析为 `SessionEventRecord` 异步迭代。
 * `open` 负责建立连接并返回 response body，便于重试或注入。
 */
export async function* streamServerSentEvents(
  open: () => Promise<ReadableStream<Uint8Array>>,
): AsyncIterable<SessionEventRecord> {
  const reader = (await open()).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // SSE 事件以空行分隔
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseSseFrame(frame);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const event = parseSseFrame(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

/** 解析单个 SSE frame 的 `data:` 行，得到事件 JSON。 */
function parseSseFrame(frame: string): SessionEventRecord | undefined {
  let data = "";
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return undefined;
  return JSON.parse(data) as SessionEventRecord;
}
