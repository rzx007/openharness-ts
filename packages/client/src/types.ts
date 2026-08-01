/**
 * 客户端公开类型。
 *
 * 会话/事件/权限等记录类型来自 `@openharness/services`；本文件补充
 * HTTP 请求参数、响应体，以及 reducer 使用的本地聚合状态结构。
 */

import type {
  AdmitPromptInput,
  CreateSessionInput,
  InputDelivery,
  PermissionRequestRecord,
  PermissionStatus,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionStateSnapshot,
  ListMessagePartsOptions,
} from "@openharness/services";

export type {
  InputDelivery,
  PermissionRequestRecord,
  PermissionStatus,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionStateSnapshot,
  ListMessagePartsOptions,
};

/** `OpenHarnessClient` 构造参数。 */
export interface OpenHarnessClientOptions {
  /** daemon HTTP 根地址，例如 `http://127.0.0.1:8787`。 */
  baseUrl: string;
  /** Bearer token；与 daemon registry 中的 token 对应。 */
  token?: string;
  /** 可注入的 fetch，便于测试或自定义传输。 */
  fetch?: typeof fetch;
}

export interface OpenHarnessServerHealth {
  ok: true;
  version?: string;
}

/** `GET /sessions` 查询参数。 */
export interface ListSessionsOptions {
  cwd?: string;
  includeArchived?: boolean;
  limit?: number;
}

/** `POST /sessions` 请求体。 */
export type CreateClientSessionInput = CreateSessionInput;

/** `POST /sessions/:id/prompts` 请求体。 */
export interface AdmitClientPromptInput {
  id?: string;
  content: string;
  delivery?: InputDelivery;
  metadata?: Record<string, unknown>;
}

/** `GET /sessions/:id/messages` 查询参数。 */
export interface ListMessagesOptions {
  cursor?: number;
  afterSeq?: number;
  limit?: number;
}

/** `GET /sessions/:id/parts` 查询参数。 */
export interface ListClientMessagePartsOptions {
  cursor?: number;
  afterSeq?: number;
  messageId?: string;
  limit?: number;
}

/** `GET /events` 查询参数。 */
export interface ListEventsOptions {
  cursor?: number;
  afterSeq?: number;
  sessionId?: string;
  limit?: number;
}

/** `GET /permissions` 查询参数。 */
export interface ListPermissionsOptions {
  sessionId?: string;
  status?: PermissionStatus;
  toolName?: string;
  limit?: number;
}

/** `POST /permissions/:id/reply` 请求体。 */
export interface ReplyPermissionInput {
  status: Extract<PermissionStatus, "approved" | "denied" | "expired">;
  decision?: "once" | "session";
  clientId?: string;
}

/** `POST /sessions/:id/prompts` 响应。 */
export interface PromptResponse {
  input: SessionInputRecord;
  run?: SessionRunRecord;
  queue_state?: "running" | "queued";
}

/** `POST /sessions/:id/interrupt` 响应。 */
export interface InterruptSessionResponse {
  activeRunId?: string;
  queuedRunIds: string[];
  interrupted: boolean;
}

/**
 * 单个 session 在客户端的聚合视图。
 * 由事件 reducer 从 event log 归并得出，不是服务端直接返回的结构。
 */
export interface SessionBucket {
  session?: SessionRecord;
  inputs: SessionInputRecord[];
  messages: SessionMessageRecord[];
  partsByMessageId: Record<string, SessionMessagePartRecord[]>;
  runs: Record<string, SessionRunRecord>;
  permissions: Record<string, PermissionRequestRecord>;
}

/**
 * 客户端权威状态：由 snapshot/live（或全局 replay/live）经 reducer 收敛。
 * 多端 attach 同一 daemon 时，应得到一致的状态形状。
 */
export interface OpenHarnessClientState {
  sessions: Record<string, SessionRecord>;
  /** 按 `updatedAt` 降序的 session id 列表。 */
  sessionOrder: string[];
  buckets: Record<string, SessionBucket>;
  /** 已应用事件，按 seq 去重。 */
  eventsBySeq: Record<number, SessionEventRecord>;
  /** 当前已应用到的最大事件序号，用作 SSE cursor。 */
  lastSeq: number;
}

/** `syncEvents` / `streamEvents` 的过滤与取消选项。 */
export interface EventSyncOptions {
  sessionId?: string;
  cursor?: number;
  signal?: AbortSignal;
}

/** `syncEvents` 产出的单次状态更新。 */
export interface SyncEventUpdate {
  event?: SessionEventRecord;
  state: OpenHarnessClientState;
  /** Session attach starts from an atomic snapshot, then consumes SSE deltas. */
  source: "snapshot" | "replay" | "live";
}

/** 去掉 sessionId 后的 admit prompt 输入（sessionId 由路径提供）。 */
export type PromptInputForClient = Omit<AdmitPromptInput, "sessionId">;
