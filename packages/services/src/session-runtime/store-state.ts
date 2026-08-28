import type {
  PermissionRequestRecord,
  AttachmentLimits,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  SessionEventRecord,
  SessionInputAttachmentRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionRunAttemptRecord,
  SessionExecutionRecord,
} from "@openharness/protocol";
import type { DurableEventRegistry } from "./event-registry.js";

export interface SessionState {
  nextEventSeq: number;
  sessions: Record<string, SessionRecord>;
  inputs: Record<string, SessionInputRecord>;
  inputAttachments: Record<string, SessionInputAttachmentRecord>;
  messages: Record<string, SessionMessageRecord>;
  parts: Record<string, SessionMessagePartRecord>;
  events: SessionEventRecord[];
  runs: Record<string, SessionRunRecord>;
  attempts: Record<string, SessionRunAttemptRecord>;
  tasks: Record<string, SessionExecutionRecord>;
  permissions: Record<string, PermissionRequestRecord>;
}

export interface SessionStoreOptions {
  path: string;
  deltaFlushIntervalMs?: number;
  deltaFlushBytes?: number;
  /** Dedicated extension point for tests or plugins that own additional event contracts. */
  eventRegistry?: DurableEventRegistry;
  attachmentLimits?: Partial<AttachmentLimits>;
}

export interface StoreMutations {
  sessions: Set<string>;
  inputs: Set<string>;
  inputAttachments: Set<string>;
  messages: Set<string>;
  parts: Set<string>;
  runs: Set<string>;
  attempts: Set<string>;
  tasks: Set<string>;
  permissions: Set<string>;
  events: Set<string>;
  deletedMessages: Set<string>;
  deletedParts: Set<string>;
  deletedInputAttachments: Set<string>;
  deletedInputs: Set<string>;
  deletedRuns: Set<string>;
  deletedAttempts: Set<string>;
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
    inputAttachments: {},
    messages: {},
    parts: {},
    events: [],
    runs: {},
    attempts: {},
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
  return value ? (JSON.parse(value) as Record<string, unknown>) : {};
}

export function isDurableEvent(event: SessionEventRecord): boolean {
  return event.type !== "session.message.part.delta";
}

export function emptyMutations(): StoreMutations {
  return {
    sessions: new Set(),
    inputs: new Set(),
    inputAttachments: new Set(),
    messages: new Set(),
    parts: new Set(),
    runs: new Set(),
    attempts: new Set(),
    tasks: new Set(),
    permissions: new Set(),
    events: new Set(),
    deletedMessages: new Set(),
    deletedParts: new Set(),
    deletedInputAttachments: new Set(),
    deletedInputs: new Set(),
    deletedRuns: new Set(),
    deletedAttempts: new Set(),
  };
}

export function cloneMutations(value: StoreMutations): StoreMutations {
  return {
    sessions: new Set(value.sessions),
    inputs: new Set(value.inputs),
    inputAttachments: new Set(value.inputAttachments),
    messages: new Set(value.messages),
    parts: new Set(value.parts),
    runs: new Set(value.runs),
    attempts: new Set(value.attempts),
    tasks: new Set(value.tasks),
    permissions: new Set(value.permissions),
    events: new Set(value.events),
    deletedMessages: new Set(value.deletedMessages),
    deletedParts: new Set(value.deletedParts),
    deletedInputAttachments: new Set(value.deletedInputAttachments),
    deletedInputs: new Set(value.deletedInputs),
    deletedRuns: new Set(value.deletedRuns),
    deletedAttempts: new Set(value.deletedAttempts),
  };
}

export function isTerminalRunStatus(
  status: SessionRunRecord["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "interrupted"
  );
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

export function assertSession(
  state: SessionState,
  sessionId: string,
): SessionRecord {
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

export function assertMessage(
  state: SessionState,
  messageId: string,
): SessionMessageRecord {
  const message = state.messages[messageId];
  if (!message) throw new Error(`Session message not found: ${messageId}`);
  return message;
}

export function scheduledTaskFromRow(
  row: Record<string, unknown>,
): ScheduledTaskRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    ...(row.description ? { description: row.description as string } : {}),
    prompt: row.prompt as string,
    recurrence: row.recurrence as string,
    recurrenceFormat:
      row.recurrence_format as ScheduledTaskRecord["recurrenceFormat"],
    timezone: row.timezone as string,
    status: row.status as ScheduledTaskRecord["status"],
    destination: row.destination as ScheduledTaskRecord["destination"],
    ...(row.session_id ? { sessionId: row.session_id as string } : {}),
    projectPaths: parseJson<string[]>(row.project_paths_json, []),
    executionMode: row.execution_mode as ScheduledTaskRecord["executionMode"],
    ...(row.model ? { model: row.model as string } : {}),
    ...(row.effort ? { effort: row.effort as string } : {}),
    skillNames: parseJson<string[]>(row.skill_names_json, []),
    pluginNames: parseJson<string[]>(row.plugin_names_json, []),
    permissionProfile: parseJson<ScheduledTaskRecord["permissionProfile"]>(
      row.permission_profile_json,
      { mode: "workspace_write" },
    ),
    overlapPolicy: row.overlap_policy as ScheduledTaskRecord["overlapPolicy"],
    missedRunPolicy:
      row.missed_run_policy as ScheduledTaskRecord["missedRunPolicy"],
    ...(row.stop_policy_json
      ? { stopPolicy: parseJson(row.stop_policy_json, {}) }
      : {}),
    createdBy: row.created_by as ScheduledTaskRecord["createdBy"],
    ...(row.created_from_session_id
      ? { createdFromSessionId: row.created_from_session_id as string }
      : {}),
    ...(row.last_run_at ? { lastRunAt: row.last_run_at as number } : {}),
    ...(row.next_run_at ? { nextRunAt: row.next_run_at as number } : {}),
    runCount: row.run_count as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function scheduledRunFromRow(
  row: Record<string, unknown>,
): ScheduledRunRecord {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    cause: row.cause as ScheduledRunRecord["cause"],
    status: row.status as ScheduledRunRecord["status"],
    scheduledFor: row.scheduled_for as number,
    ...(row.session_id ? { sessionId: row.session_id as string } : {}),
    ...(row.run_id ? { runId: row.run_id as string } : {}),
    ...(row.summary ? { summary: row.summary as string } : {}),
    ...(row.error ? { error: row.error as string } : {}),
    unread: row.unread === 1,
    ...(row.attention_reason
      ? { attentionReason: row.attention_reason as string }
      : {}),
    createdAt: row.created_at as number,
    ...(row.started_at ? { startedAt: row.started_at as number } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}),
    updatedAt: row.updated_at as number,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
