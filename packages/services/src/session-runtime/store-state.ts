import type {
  CronJobRecord,
  CronRunRecord,
  CronRunStatus,
  PermissionRequestRecord,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionTaskRecord,
} from "./types.js";

export interface SessionState {
  nextEventSeq: number;
  sessions: Record<string, SessionRecord>;
  inputs: Record<string, SessionInputRecord>;
  messages: Record<string, SessionMessageRecord>;
  parts: Record<string, SessionMessagePartRecord>;
  events: SessionEventRecord[];
  runs: Record<string, SessionRunRecord>;
  tasks: Record<string, SessionTaskRecord>;
  permissions: Record<string, PermissionRequestRecord>;
}

export interface SessionStoreOptions {
  path: string;
  deltaFlushIntervalMs?: number;
  deltaFlushBytes?: number;
}

export interface StoreMutations {
  sessions: Set<string>;
  inputs: Set<string>;
  messages: Set<string>;
  parts: Set<string>;
  runs: Set<string>;
  tasks: Set<string>;
  permissions: Set<string>;
  events: Set<string>;
  deletedMessages: Set<string>;
  deletedParts: Set<string>;
}

export const DEFAULT_DELTA_FLUSH_INTERVAL_MS = 150;
export const DEFAULT_DELTA_FLUSH_BYTES = 8 * 1024;
export const EVENT_SEQUENCE_BLOCK_SIZE = 1024;

export function now(): number {
  return Date.now();
}

export function emptyState(): SessionState {
  return {
    nextEventSeq: 1,
    sessions: {},
    inputs: {},
    messages: {},
    parts: {},
    events: [],
    runs: {},
    tasks: {},
    permissions: {},
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function encode(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function decode(value: string | null): Record<string, unknown> {
  return value ? JSON.parse(value) as Record<string, unknown> : {};
}

export function isDurableEvent(event: SessionEventRecord): boolean {
  return event.type !== "session.message.part.delta";
}

export function emptyMutations(): StoreMutations {
  return {
    sessions: new Set(),
    inputs: new Set(),
    messages: new Set(),
    parts: new Set(),
    runs: new Set(),
    tasks: new Set(),
    permissions: new Set(),
    events: new Set(),
    deletedMessages: new Set(),
    deletedParts: new Set(),
  };
}

export function cloneMutations(value: StoreMutations): StoreMutations {
  return {
    sessions: new Set(value.sessions),
    inputs: new Set(value.inputs),
    messages: new Set(value.messages),
    parts: new Set(value.parts),
    runs: new Set(value.runs),
    tasks: new Set(value.tasks),
    permissions: new Set(value.permissions),
    events: new Set(value.events),
    deletedMessages: new Set(value.deletedMessages),
    deletedParts: new Set(value.deletedParts),
  };
}

export function isTerminalRunStatus(status: SessionRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

export function maxSeq<T extends { sessionId: string; seq: number }>(
  table: Record<string, T>,
  sessionId: string,
): number {
  let seq = 0;
  for (const row of Object.values(table)) {
    if (row.sessionId === sessionId && row.seq > seq) seq = row.seq;
  }
  return seq;
}

export function assertSession(state: SessionState, sessionId: string): SessionRecord {
  const session = state.sessions[sessionId];
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

export function assertMutableSession(session: SessionRecord): void {
  if (session.status === "archived") {
    throw new Error(`Session is archived: ${session.id}`);
  }
  if (session.status === "closing") {
    throw new Error(`Session is closing: ${session.id}`);
  }
}

export function assertMessage(state: SessionState, messageId: string): SessionMessageRecord {
  const message = state.messages[messageId];
  if (!message) throw new Error(`Session message not found: ${messageId}`);
  return message;
}

export function cronJobFromRow(row: Record<string, unknown>): CronJobRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    expression: row.expression as string,
    command: row.command as string,
    cwd: row.cwd as string,
    ...(row.timezone ? { timezone: row.timezone as string } : {}),
    enabled: row.enabled === 1,
    ...(row.last_run_at ? { lastRunAt: row.last_run_at as number } : {}),
    ...(row.next_run_at ? { nextRunAt: row.next_run_at as number } : {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function cronRunFromRow(row: Record<string, unknown>): CronRunRecord {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    jobName: row.job_name as string,
    cause: row.cause as CronRunRecord["cause"],
    status: row.status as CronRunStatus,
    ...(row.output ? { output: row.output as string } : {}),
    ...(row.error ? { error: row.error as string } : {}),
    startedAt: row.started_at as number,
    ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}),
  };
}
