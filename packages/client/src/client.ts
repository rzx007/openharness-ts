/**
 * daemon HTTP/SSE 客户端。
 *
 * 包装 `@openharness/server` 的 REST 路由与 `/events/stream` SSE；
 * 不含本地状态归并（见 `reducer.ts` / `sync.ts`）。
 */

import type {
  AdmitClientPromptInput,
  CreateClientSessionInput,
  EventSyncOptions,
  InterruptSessionResponse,
  ListClientMessagePartsOptions,
  ListEventsOptions,
  ListMessagesOptions,
  ListPermissionsOptions,
  ListSessionsOptions,
  OpenHarnessClientOptions,
  OpenHarnessServerHealth,
  PermissionRequestRecord,
  PromptResponse,
  ReplyPermissionInput,
  SessionEventRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionStateSnapshot,
} from "./types.js";

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
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** `GET /health` */
  async health(options: { signal?: AbortSignal } = {}): Promise<OpenHarnessServerHealth> {
    return this.request<OpenHarnessServerHealth>("/health", { signal: options.signal });
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
    options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: this.headers(options.body !== undefined),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    if (!response.ok) await this.throwResponseError(response);
    return await response.json() as T;
  }

  private headers(json = false): Record<string, string> {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
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
