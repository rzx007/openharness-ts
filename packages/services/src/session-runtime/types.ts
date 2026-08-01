export type SessionStatus = "idle" | "running" | "archived" | "error";
export type InputDelivery = "queue" | "steer";
export type RunStatus = "pending" | "running" | "completed" | "failed" | "interrupted";
export type PermissionStatus = "pending" | "approved" | "denied" | "expired";
export type SessionMessageRole = "system" | "user" | "assistant";
export type SessionMessagePartType = "text" | "reasoning" | "tool" | "tool_result" | "error" | "log";
export type SessionMessagePartStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

export interface SessionRecord {
  id: string;
  parentId?: string;
  cwd: string;
  title: string;
  model: string;
  agent?: string;
  status: SessionStatus;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface SessionInputRecord {
  id: string;
  sessionId: string;
  seq: number;
  delivery: InputDelivery;
  content: string;
  promotedMessageId?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface SessionMessageRecord {
  id: string;
  sessionId: string;
  seq: number;
  role: SessionMessageRole;
  runId?: string;
  inputId?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMessagePartRecord {
  id: string;
  sessionId: string;
  messageId: string;
  seq: number;
  type: SessionMessagePartType;
  status: SessionMessagePartStatus;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SessionEventRecord {
  id: string;
  seq: number;
  type: string;
  sessionId?: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface SessionRunRecord {
  id: string;
  sessionId: string;
  inputId?: string;
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface PermissionRequestRecord {
  id: string;
  sessionId: string;
  runId?: string;
  toolName: string;
  payload: Record<string, unknown>;
  status: PermissionStatus;
  decision?: string;
  decidedByClientId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Atomic, server-owned state used when a client attaches to one session. */
export interface SessionStateSnapshot {
  cursor: number;
  session: SessionRecord;
  inputs: SessionInputRecord[];
  messages: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
  runs: SessionRunRecord[];
  permissions: PermissionRequestRecord[];
}

export interface CreateSessionInput {
  id?: string;
  parentId?: string;
  cwd: string;
  title?: string;
  model: string;
  agent?: string;
  metadata?: Record<string, unknown>;
}

export interface AdmitPromptInput {
  id?: string;
  sessionId: string;
  delivery?: InputDelivery;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CreateMessageInput {
  id?: string;
  sessionId: string;
  role: SessionMessageRole;
  runId?: string;
  inputId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpsertMessagePartInput {
  id?: string;
  sessionId: string;
  messageId: string;
  type: SessionMessagePartType;
  status?: SessionMessagePartStatus;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AppendMessagePartDeltaInput {
  sessionId: string;
  messageId: string;
  partId: string;
  field: "text";
  delta: string;
}

export interface AppendEventInput {
  id?: string;
  type: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export interface CreateRunInput {
  id?: string;
  sessionId: string;
  inputId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateRunInput {
  status?: RunStatus;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePermissionRequestInput {
  id?: string;
  sessionId: string;
  runId?: string;
  toolName: string;
  payload?: Record<string, unknown>;
}

export interface ReplyPermissionInput {
  requestId: string;
  status: Extract<PermissionStatus, "approved" | "denied" | "expired">;
  decision?: string;
  clientId?: string;
}

export interface ListPermissionRequestsOptions {
  sessionId?: string;
  status?: PermissionStatus;
  toolName?: string;
  limit?: number;
}

export interface ListEventsOptions {
  afterSeq?: number;
  sessionId?: string;
  limit?: number;
}

export interface ListSessionsOptions {
  cwd?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface ListMessagesOptions {
  afterSeq?: number;
  limit?: number;
}

export interface ListMessagePartsOptions {
  afterSeq?: number;
  messageId?: string;
  limit?: number;
}
