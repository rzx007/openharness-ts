import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type {
  AdmitPromptInput,
  AppendEventInput,
  AppendMessagePartDeltaInput,
  CreateMessageInput,
  CreatePermissionRequestInput,
  CreateRunInput,
  CreateSessionTaskInput,
  CreateSessionInput,
  ListEventsOptions,
  ListMessagePartsOptions,
  ListMessagesOptions,
  ListPermissionRequestsOptions,
  ListSessionsOptions,
  PermissionRequestRecord,
  ReplyPermissionInput,
  SessionMessagePartRecord,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionTaskRecord,
  SessionStateSnapshot,
  UpsertMessagePartInput,
  UpdateRunInput,
  UpdateSessionTaskInput,
  UpdateSessionInput,
  ReplaceTranscriptInput,
} from "./types.js";
import { formatSessionTitle, isPlaceholderSessionTitle } from "./title.js";

interface SessionState {
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
}

function now(): number {
  return Date.now();
}

function emptyState(): SessionState {
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function encode(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function decode(value: string | null): Record<string, unknown> {
  return value ? JSON.parse(value) as Record<string, unknown> : {};
}

function maxSeq<T extends { sessionId: string; seq: number }>(
  table: Record<string, T>,
  sessionId: string,
): number {
  let seq = 0;
  for (const row of Object.values(table)) {
    if (row.sessionId === sessionId && row.seq > seq) seq = row.seq;
  }
  return seq;
}

function assertSession(state: SessionState, sessionId: string): SessionRecord {
  const session = state.sessions[sessionId];
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

function assertMutableSession(session: SessionRecord): void {
  if (session.status === "archived") {
    throw new Error(`Session is archived: ${session.id}`);
  }
  if (session.status === "closing") {
    throw new Error(`Session is closing: ${session.id}`);
  }
}

function assertMessage(state: SessionState, messageId: string): SessionMessageRecord {
  const message = state.messages[messageId];
  if (!message) throw new Error(`Session message not found: ${messageId}`);
  return message;
}

export class SessionStore {
  readonly path: string;
  private readonly database: Database.Database;
  private closed = false;
  private state: SessionState;

  constructor(options: SessionStoreOptions) {
    this.path = resolve(options.path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.database = new Database(this.path);
    try {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
      this.database.pragma("synchronous = NORMAL");
      this.applyMigrations();
      this.state = this.load();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const id = input.id ?? randomUUID();
    if (this.state.sessions[id]) throw new Error(`Session already exists: ${id}`);
    const timestamp = now();
    const session: SessionRecord = {
      id,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      cwd: resolve(input.cwd),
      title: input.title ?? "",
      model: input.model,
      ...(input.agent ? { agent: input.agent } : {}),
      status: "idle",
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.sessions[id] = session;
    this.appendEventInMemory({
      type: "session.created",
      sessionId: id,
      payload: { session },
    });
    this.save();
    return clone(session);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const session = this.state.sessions[sessionId];
    return session ? clone(session) : undefined;
  }

  listSessions(options: ListSessionsOptions = {}): SessionRecord[] {
    const cwd = options.cwd ? resolve(options.cwd) : undefined;
    let sessions = Object.values(this.state.sessions);
    if (cwd) sessions = sessions.filter((session) => session.cwd === cwd);
    if (!options.includeArchived) sessions = sessions.filter((session) => session.status !== "archived");
    sessions = sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    if (options.limit !== undefined) sessions = sessions.slice(0, options.limit);
    return clone(sessions);
  }

  listChildSessions(parentId: string): SessionRecord[] {
    assertSession(this.state, parentId);
    return clone(Object.values(this.state.sessions)
      .filter((session) => session.parentId === parentId && session.status !== "archived")
      .sort((a, b) => a.createdAt - b.createdAt));
  }

  archiveSession(sessionId: string): SessionRecord {
    const session = assertSession(this.state, sessionId);
    if (session.status === "archived") return clone(session);
    const timestamp = now();
    session.status = "archived";
    session.updatedAt = timestamp;
    session.archivedAt = timestamp;
    this.appendEventInMemory({
      type: "session.archived",
      sessionId,
      payload: { sessionId },
    });
    this.save();
    return clone(session);
  }

  /** Prevent further mutation while the server joins interrupted work. */
  beginArchive(sessionId: string): SessionRecord {
    const session = assertSession(this.state, sessionId);
    if (session.status === "archived" || session.status === "closing") return clone(session);
    const timestamp = now();
    session.status = "closing";
    session.updatedAt = timestamp;
    this.appendEventInMemory({
      type: "session.closing",
      sessionId,
      payload: { sessionId },
    });
    this.save();
    return clone(session);
  }

  updateSession(sessionId: string, input: UpdateSessionInput): SessionRecord {
    const session = assertSession(this.state, sessionId);
    assertMutableSession(session);
    const timestamp = now();
    if (input.title !== undefined) session.title = input.title;
    if (input.model !== undefined) session.model = input.model;
    if (input.agent !== undefined) {
      if (input.agent === null) delete session.agent;
      else session.agent = input.agent;
    }
    if (input.metadata !== undefined) session.metadata = input.metadata;
    session.updatedAt = timestamp;
    this.appendEventInMemory({
      type: "session.updated",
      sessionId,
      payload: { session: clone(session) },
    });
    this.save();
    return clone(session);
  }

  admitPrompt(input: AdmitPromptInput): SessionInputRecord {
    const session = assertSession(this.state, input.sessionId);
    assertMutableSession(session);
    const id = input.id ?? randomUUID();
    if (this.state.inputs[id]) throw new Error(`Session input already exists: ${id}`);
    const timestamp = now();
    const seq = maxSeq(this.state.inputs, input.sessionId) + 1;
    const row: SessionInputRecord = {
      id,
      sessionId: input.sessionId,
      seq,
      delivery: input.delivery ?? "queue",
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: timestamp,
    };
    this.state.inputs[id] = row;
    session.updatedAt = timestamp;
    if (seq === 1 && isPlaceholderSessionTitle(session.title)) {
      const title = formatSessionTitle(input.content);
      if (title) session.title = title;
    }
    this.appendEventInMemory({
      type: "session.input.admitted",
      sessionId: input.sessionId,
      payload: { input: row },
    });
    this.save();
    return clone(row);
  }

  /** Prefer first prompt text for list labels; fall back to stored title. */
  resolveSessionListTitle(sessionId: string): string {
    const session = assertSession(this.state, sessionId);
    const first = Object.values(this.state.inputs)
      .filter((input) => input.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq)[0];
    const fromPrompt = first ? formatSessionTitle(first.content) : "";
    if (fromPrompt) return fromPrompt;
    const stored = session.title.trim();
    if (stored && !isPlaceholderSessionTitle(stored)) return formatSessionTitle(stored);
    if (stored) return stored;
    return session.id.slice(0, 8);
  }

  getInput(inputId: string): SessionInputRecord | undefined {
    const input = this.state.inputs[inputId];
    return input ? clone(input) : undefined;
  }

  listInputs(sessionId: string): SessionInputRecord[] {
    assertSession(this.state, sessionId);
    return clone(Object.values(this.state.inputs)
      .filter((input) => input.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq));
  }

  /**
   * Inputs not yet bound to a run and not yet promoted into a transcript message.
   * Used by steer delivery to pull follow-ups into an active run.
   */
  listUnboundInputs(sessionId: string): SessionInputRecord[] {
    assertSession(this.state, sessionId);
    const boundToRun = new Set(
      Object.values(this.state.runs)
        .filter((run) => run.sessionId === sessionId && run.inputId)
        .map((run) => run.inputId!),
    );
    const promoted = new Set(
      Object.values(this.state.messages)
        .filter((message) => message.sessionId === sessionId && message.inputId)
        .map((message) => message.inputId!),
    );
    return clone(
      Object.values(this.state.inputs)
        .filter((input) =>
          input.sessionId === sessionId &&
          !boundToRun.has(input.id) &&
          !promoted.has(input.id))
        .sort((a, b) => a.seq - b.seq),
    );
  }

  createMessage(input: CreateMessageInput): SessionMessageRecord {
    const session = assertSession(this.state, input.sessionId);
    const id = input.id ?? randomUUID();
    if (this.state.messages[id]) throw new Error(`Session message already exists: ${id}`);
    const timestamp = now();
    const row: SessionMessageRecord = {
      id,
      sessionId: input.sessionId,
      seq: maxSeq(this.state.messages, input.sessionId) + 1,
      role: input.role,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.inputId ? { inputId: input.inputId } : {}),
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.messages[id] = row;
    session.updatedAt = timestamp;
    this.appendEventInMemory({
      type: "session.message.created",
      sessionId: input.sessionId,
      payload: { message: row },
    });
    this.save();
    return clone(row);
  }

  listMessages(sessionId: string, options: ListMessagesOptions = {}): SessionMessageRecord[] {
    assertSession(this.state, sessionId);
    let messages = Object.values(this.state.messages)
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq);
    if (options.afterSeq !== undefined) messages = messages.filter((message) => message.seq > options.afterSeq!);
    if (options.limit !== undefined) messages = messages.slice(0, options.limit);
    return clone(messages);
  }

  /**
   * Replace a session transcript atomically (used by /compact).
   * Emits a single `session.transcript.replaced` event with the new messages/parts.
   */
  replaceTranscript(input: ReplaceTranscriptInput): {
    messages: SessionMessageRecord[];
    parts: SessionMessagePartRecord[];
  } {
    const session = assertSession(this.state, input.sessionId);
    const timestamp = now();

    for (const [id, message] of Object.entries(this.state.messages)) {
      if (message.sessionId === input.sessionId) delete this.state.messages[id];
    }
    for (const [id, part] of Object.entries(this.state.parts)) {
      if (part.sessionId === input.sessionId) delete this.state.parts[id];
    }

    const messages: SessionMessageRecord[] = [];
    const parts: SessionMessagePartRecord[] = [];
    let messageSeq = 0;
    let partSeq = 0;

    for (const row of input.messages) {
      messageSeq += 1;
      const messageId = randomUUID();
      const message: SessionMessageRecord = {
        id: messageId,
        sessionId: input.sessionId,
        seq: messageSeq,
        role: row.role,
        metadata: row.metadata ?? {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.state.messages[messageId] = message;
      messages.push(message);

      for (const partInput of row.parts) {
        partSeq += 1;
        const partId = randomUUID();
        const part: SessionMessagePartRecord = {
          id: partId,
          sessionId: input.sessionId,
          messageId,
          seq: partSeq,
          type: partInput.type,
          status: partInput.status ?? "completed",
          ...(partInput.text !== undefined ? { text: partInput.text } : {}),
          ...(partInput.toolUseId !== undefined ? { toolUseId: partInput.toolUseId } : {}),
          ...(partInput.toolName !== undefined ? { toolName: partInput.toolName } : {}),
          ...(partInput.input !== undefined ? { input: partInput.input } : {}),
          ...(partInput.output !== undefined ? { output: partInput.output } : {}),
          ...(partInput.isError !== undefined ? { isError: partInput.isError } : {}),
          metadata: partInput.metadata ?? {},
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.state.parts[partId] = part;
        parts.push(part);
      }
    }

    session.updatedAt = timestamp;
    this.appendEventInMemory({
      type: "session.transcript.replaced",
      sessionId: input.sessionId,
      payload: { messages: clone(messages), parts: clone(parts) },
    });
    this.save();
    return { messages: clone(messages), parts: clone(parts) };
  }

  upsertMessagePart(input: UpsertMessagePartInput): SessionMessagePartRecord {
    const session = assertSession(this.state, input.sessionId);
    const message = assertMessage(this.state, input.messageId);
    if (message.sessionId !== input.sessionId) {
      throw new Error(`Session message ${input.messageId} does not belong to session ${input.sessionId}`);
    }
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const existing = this.state.parts[id];
    const row: SessionMessagePartRecord = existing
      ? {
          ...existing,
          type: input.type,
          status: input.status ?? existing.status,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
          ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.isError !== undefined ? { isError: input.isError } : {}),
          metadata: input.metadata ? { ...existing.metadata, ...input.metadata } : existing.metadata,
          updatedAt: timestamp,
        }
      : {
          id,
          sessionId: input.sessionId,
          messageId: input.messageId,
          seq: maxSeq(this.state.parts, input.sessionId) + 1,
          type: input.type,
          status: input.status ?? "pending",
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
          ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.isError !== undefined ? { isError: input.isError } : {}),
          metadata: input.metadata ?? {},
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    this.state.parts[id] = row;
    message.updatedAt = timestamp;
    session.updatedAt = timestamp;
    this.appendEventInMemory({
      type: "session.message.part.updated",
      sessionId: input.sessionId,
      payload: { part: row },
    });
    this.save();
    return clone(row);
  }

  appendMessagePartDelta(input: AppendMessagePartDeltaInput): SessionEventRecord {
    const session = assertSession(this.state, input.sessionId);
    const message = assertMessage(this.state, input.messageId);
    const part = this.state.parts[input.partId];
    if (!part) throw new Error(`Session message part not found: ${input.partId}`);
    if (message.sessionId !== input.sessionId || part.sessionId !== input.sessionId || part.messageId !== input.messageId) {
      throw new Error(`Session message part ${input.partId} does not belong to message ${input.messageId}`);
    }

    const timestamp = now();
    part.text = `${part.text ?? ""}${input.delta}`;
    part.updatedAt = timestamp;
    message.updatedAt = timestamp;
    session.updatedAt = timestamp;
    const event = this.appendEventInMemory({
      type: "session.message.part.delta",
      sessionId: input.sessionId,
      payload: {
        sessionId: input.sessionId,
        messageId: input.messageId,
        partId: input.partId,
        field: input.field,
        delta: input.delta,
      },
    });
    this.save();
    return clone(event);
  }

  listMessageParts(sessionId: string, options: ListMessagePartsOptions = {}): SessionMessagePartRecord[] {
    assertSession(this.state, sessionId);
    let parts = Object.values(this.state.parts)
      .filter((part) => part.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq);
    if (options.messageId) parts = parts.filter((part) => part.messageId === options.messageId);
    if (options.afterSeq !== undefined) parts = parts.filter((part) => part.seq > options.afterSeq!);
    if (options.limit !== undefined) parts = parts.slice(0, options.limit);
    return clone(parts);
  }

  appendEvent(input: AppendEventInput): SessionEventRecord {
    if (input.sessionId) assertSession(this.state, input.sessionId);
    const event = this.appendEventInMemory(input);
    this.save();
    return clone(event);
  }

  listEvents(options: ListEventsOptions = {}): SessionEventRecord[] {
    let events = this.state.events;
    if (options.afterSeq !== undefined) events = events.filter((event) => event.seq > options.afterSeq!);
    if (options.sessionId) {
      events = events.filter((event) => event.sessionId === undefined || event.sessionId === options.sessionId);
    }
    events = events.sort((a, b) => a.seq - b.seq);
    if (options.limit !== undefined) events = events.slice(0, options.limit);
    return clone(events);
  }

  createRun(input: CreateRunInput): SessionRunRecord {
    const session = assertSession(this.state, input.sessionId);
    assertMutableSession(session);
    if (input.inputId && !this.state.inputs[input.inputId]) {
      throw new Error(`Session input not found: ${input.inputId}`);
    }
    if (input.inputId && this.state.inputs[input.inputId]!.sessionId !== input.sessionId) {
      throw new Error(`Session input does not belong to session: ${input.inputId}`);
    }
    const id = input.id ?? randomUUID();
    if (this.state.runs[id]) throw new Error(`Session run already exists: ${id}`);
    const timestamp = now();
    const run: SessionRunRecord = {
      id,
      sessionId: input.sessionId,
      ...(input.inputId ? { inputId: input.inputId } : {}),
      status: "pending",
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.runs[id] = run;
    this.refreshSessionStatus(session);
    session.updatedAt = timestamp;
    this.appendEventInMemory({
      type: "session.run.created",
      sessionId: input.sessionId,
      payload: { run },
    });
    this.save();
    return clone(run);
  }

  updateRun(runId: string, input: UpdateRunInput): SessionRunRecord {
    const run = this.state.runs[runId];
    if (!run) throw new Error(`Session run not found: ${runId}`);
    const session = assertSession(this.state, run.sessionId);
    const timestamp = now();
    const previous = run.status;
    if (input.status) {
      run.status = input.status;
      if (input.status === "running" && !run.startedAt) run.startedAt = timestamp;
      if (["completed", "failed", "interrupted"].includes(input.status)) run.finishedAt = timestamp;
    }
    if (input.error !== undefined) run.error = input.error;
    if (input.metadata) run.metadata = { ...run.metadata, ...input.metadata };
    run.updatedAt = timestamp;
    this.refreshSessionStatus(session);
    session.updatedAt = timestamp;
    this.appendEventInMemory({
      type: "session.run.updated",
      sessionId: run.sessionId,
      payload: { run, previousStatus: previous },
    });
    this.save();
    return clone(run);
  }

  getRun(runId: string): SessionRunRecord | undefined {
    const run = this.state.runs[runId];
    return run ? clone(run) : undefined;
  }

  findRunByInput(inputId: string): SessionRunRecord | undefined {
    const run = Object.values(this.state.runs).find((candidate) => candidate.inputId === inputId);
    return run ? clone(run) : undefined;
  }

  listRuns(sessionId: string): SessionRunRecord[] {
    assertSession(this.state, sessionId);
    return clone(Object.values(this.state.runs)
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt));
  }

  createSessionTask(input: CreateSessionTaskInput): SessionTaskRecord {
    const session = assertSession(this.state, input.sessionId);
    const id = input.id ?? randomUUID();
    if (this.state.tasks[id]) throw new Error(`Session task already exists: ${id}`);
    if (input.childSessionId) {
      const child = assertSession(this.state, input.childSessionId);
      if (child.parentId !== input.sessionId) {
        throw new Error(`Child session does not belong to task session: ${input.childSessionId}`);
      }
    }
    if (input.runId) {
      const run = this.state.runs[input.runId];
      if (!run || run.sessionId !== input.childSessionId && run.sessionId !== input.sessionId) {
        throw new Error(`Task run does not belong to task session: ${input.runId}`);
      }
    }
    const timestamp = now();
    const task: SessionTaskRecord = {
      id,
      sessionId: input.sessionId,
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      type: input.type,
      status: "running",
      description: input.description,
      cwd: resolve(input.cwd),
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.tasks[id] = task;
    session.updatedAt = timestamp;
    this.appendEventInMemory({ type: "session.task.created", sessionId: task.sessionId, payload: { task } });
    this.save();
    return clone(task);
  }

  updateSessionTask(taskId: string, input: UpdateSessionTaskInput): SessionTaskRecord {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`Session task not found: ${taskId}`);
    const session = assertSession(this.state, task.sessionId);
    if (input.runId !== undefined) {
      const run = this.state.runs[input.runId];
      if (!run || (run.sessionId !== task.sessionId && run.sessionId !== task.childSessionId)) {
        throw new Error(`Task run does not belong to task: ${input.runId}`);
      }
      task.runId = input.runId;
    }
    const timestamp = now();
    const previousStatus = task.status;
    if (input.status) {
      task.status = input.status;
      if (input.status === "running" && !task.startedAt) task.startedAt = timestamp;
      if (["completed", "failed", "stopped", "interrupted"].includes(input.status)) task.finishedAt = timestamp;
    }
    if (input.output !== undefined) task.output = input.output;
    if (input.error !== undefined) task.error = input.error;
    if (input.metadata) task.metadata = { ...task.metadata, ...input.metadata };
    task.updatedAt = timestamp;
    session.updatedAt = timestamp;
    this.appendEventInMemory({
      type: "session.task.updated",
      sessionId: task.sessionId,
      payload: { task, previousStatus },
    });
    this.save();
    return clone(task);
  }

  getSessionTask(taskId: string): SessionTaskRecord | undefined {
    const task = this.state.tasks[taskId];
    return task ? clone(task) : undefined;
  }

  listSessionTasks(sessionId: string): SessionTaskRecord[] {
    assertSession(this.state, sessionId);
    return clone(Object.values(this.state.tasks)
      .filter((task) => task.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt));
  }

  findSessionTaskByManagerTaskId(sessionId: string, taskManagerId: string): SessionTaskRecord | undefined {
    assertSession(this.state, sessionId);
    const task = Object.values(this.state.tasks).find((candidate) =>
      candidate.sessionId === sessionId && candidate.metadata.taskManagerId === taskManagerId);
    return task ? clone(task) : undefined;
  }

  /** A daemon restart cannot retain TaskManager callbacks or process handles. */
  interruptActiveSessionTasks(reason = "Daemon restarted before the task completed"): number {
    const active = Object.values(this.state.tasks)
      .filter((task) => task.status === "pending" || task.status === "running");
    for (const task of active) {
      this.updateSessionTask(task.id, { status: "interrupted", error: reason });
    }
    return active.length;
  }

  /**
   * Mark work owned by a previous daemon process as terminal. A fresh daemon
   * cannot resume an in-memory QueryEngine run, so leaving these rows active
   * would keep every attached client permanently busy.
   */
  interruptActiveRuns(reason = "Daemon restarted before the run completed"): number {
    const active = Object.values(this.state.runs)
      .filter((run) => run.status === "pending" || run.status === "running");
    for (const run of active) this.updateRun(run.id, { status: "interrupted", error: reason });
    return active.length;
  }

  /** Complete an archive that was interrupted by a daemon process exit. */
  finalizeClosingSessions(): number {
    const closing = Object.values(this.state.sessions).filter((session) => session.status === "closing");
    for (const session of closing) {
      const hasActiveRun = Object.values(this.state.runs).some(
        (run) => run.sessionId === session.id && (run.status === "pending" || run.status === "running"),
      );
      if (!hasActiveRun) this.archiveSession(session.id);
    }
    return closing.length;
  }

  createPermissionRequest(input: CreatePermissionRequestInput): PermissionRequestRecord {
    assertSession(this.state, input.sessionId);
    if (input.runId && !this.state.runs[input.runId]) throw new Error(`Session run not found: ${input.runId}`);
    const id = input.id ?? randomUUID();
    if (this.state.permissions[id]) throw new Error(`Permission request already exists: ${id}`);
    const timestamp = now();
    const request: PermissionRequestRecord = {
      id,
      sessionId: input.sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      toolName: input.toolName,
      payload: input.payload ?? {},
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.permissions[id] = request;
    this.appendEventInMemory({
      type: "permission.asked",
      sessionId: input.sessionId,
      payload: { request },
    });
    this.save();
    return clone(request);
  }

  replyPermission(input: ReplyPermissionInput): PermissionRequestRecord {
    const request = this.state.permissions[input.requestId];
    if (!request) throw new Error(`Permission request not found: ${input.requestId}`);
    const timestamp = now();
    request.status = input.status;
    if (input.decision !== undefined) request.decision = input.decision;
    if (input.clientId !== undefined) request.decidedByClientId = input.clientId;
    request.updatedAt = timestamp;
    this.appendEventInMemory({
      type: "permission.replied",
      sessionId: request.sessionId,
      payload: { request },
    });
    this.save();
    return clone(request);
  }

  getPermissionRequest(requestId: string): PermissionRequestRecord | undefined {
    const request = this.state.permissions[requestId];
    return request ? clone(request) : undefined;
  }

  listPermissionRequests(options: ListPermissionRequestsOptions = {}): PermissionRequestRecord[] {
    let requests = Object.values(this.state.permissions);
    if (options.sessionId) requests = requests.filter((request) => request.sessionId === options.sessionId);
    if (options.status) requests = requests.filter((request) => request.status === options.status);
    if (options.toolName) requests = requests.filter((request) => request.toolName === options.toolName);
    requests = requests.sort((a, b) => a.createdAt - b.createdAt);
    if (options.limit !== undefined) requests = requests.slice(0, options.limit);
    return clone(requests);
  }

  /** Read one session and its canonical children at a single event cursor. */
  getSessionState(sessionId: string): SessionStateSnapshot {
    const session = assertSession(this.state, sessionId);
    return clone({
      cursor: this.state.nextEventSeq - 1,
      session,
      inputs: Object.values(this.state.inputs)
        .filter((input) => input.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq),
      messages: Object.values(this.state.messages)
        .filter((message) => message.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq),
      parts: Object.values(this.state.parts)
        .filter((part) => part.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq),
      runs: Object.values(this.state.runs)
        .filter((run) => run.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
      tasks: Object.values(this.state.tasks)
        .filter((task) => task.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
      permissions: Object.values(this.state.permissions)
        .filter((request) => request.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
    });
  }

  private appendEventInMemory(input: AppendEventInput): SessionEventRecord {
    const event: SessionEventRecord = {
      id: input.id ?? randomUUID(),
      seq: this.state.nextEventSeq++,
      type: input.type,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      payload: input.payload ?? {},
      createdAt: now(),
    };
    this.state.events.push(event);
    return event;
  }

  private refreshSessionStatus(session: SessionRecord): void {
    if (session.status === "archived" || session.status === "closing") return;
    const hasActiveRun = Object.values(this.state.runs).some(
      (run) => run.sessionId === session.id && (run.status === "pending" || run.status === "running"),
    );
    session.status = hasActiveRun ? "running" : "idle";
  }

  private applyMigrations(): void {
    migrate(drizzle(this.database), {
      migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)),
    });
  }

  private load(): SessionState {
    const state = emptyState();
    for (const row of this.database.prepare("SELECT * FROM session").all() as Array<Record<string, unknown>>) {
      const session: SessionRecord = {
        id: row.id as string,
        ...(row.parent_id ? { parentId: row.parent_id as string } : {}),
        cwd: row.cwd as string,
        title: row.title as string,
        model: row.model as string,
        ...(row.agent ? { agent: row.agent as string } : {}),
        status: row.status as SessionRecord["status"],
        metadata: decode(row.metadata_json as string),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
        ...(row.archived_at ? { archivedAt: row.archived_at as number } : {}),
      };
      state.sessions[session.id] = session;
    }
    for (const row of this.database.prepare("SELECT * FROM session_input").all() as Array<Record<string, unknown>>) {
      const input: SessionInputRecord = { id: row.id as string, sessionId: row.session_id as string, seq: row.seq as number, delivery: row.delivery as SessionInputRecord["delivery"], content: row.content as string, metadata: decode(row.metadata_json as string), createdAt: row.created_at as number };
      state.inputs[input.id] = input;
    }
    for (const row of this.database.prepare("SELECT * FROM session_message").all() as Array<Record<string, unknown>>) {
      const message: SessionMessageRecord = { id: row.id as string, sessionId: row.session_id as string, seq: row.seq as number, role: row.role as SessionMessageRecord["role"], ...(row.run_id ? { runId: row.run_id as string } : {}), ...(row.input_id ? { inputId: row.input_id as string } : {}), metadata: decode(row.metadata_json as string), createdAt: row.created_at as number, updatedAt: row.updated_at as number };
      state.messages[message.id] = message;
    }
    for (const row of this.database.prepare("SELECT * FROM session_message_part").all() as Array<Record<string, unknown>>) {
      const part: SessionMessagePartRecord = { id: row.id as string, sessionId: row.session_id as string, messageId: row.message_id as string, seq: row.seq as number, type: row.type as SessionMessagePartRecord["type"], status: row.status as SessionMessagePartRecord["status"], ...(row.text !== null ? { text: row.text as string } : {}), ...(row.tool_use_id ? { toolUseId: row.tool_use_id as string } : {}), ...(row.tool_name ? { toolName: row.tool_name as string } : {}), ...(row.input_json ? { input: decode(row.input_json as string) } : {}), ...(row.output_json ? { output: JSON.parse(row.output_json as string) } : {}), ...(row.is_error !== null ? { isError: Boolean(row.is_error) } : {}), metadata: decode(row.metadata_json as string), createdAt: row.created_at as number, updatedAt: row.updated_at as number };
      state.parts[part.id] = part;
    }
    for (const row of this.database.prepare("SELECT * FROM session_run").all() as Array<Record<string, unknown>>) {
      const run: SessionRunRecord = { id: row.id as string, sessionId: row.session_id as string, ...(row.input_id ? { inputId: row.input_id as string } : {}), status: row.status as SessionRunRecord["status"], ...(row.started_at ? { startedAt: row.started_at as number } : {}), ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}), ...(row.error ? { error: row.error as string } : {}), metadata: decode(row.metadata_json as string), createdAt: row.created_at as number, updatedAt: row.updated_at as number };
      state.runs[run.id] = run;
    }
    for (const row of this.database.prepare("SELECT * FROM session_task").all() as Array<Record<string, unknown>>) {
      const task: SessionTaskRecord = { id: row.id as string, sessionId: row.session_id as string, ...(row.child_session_id ? { childSessionId: row.child_session_id as string } : {}), ...(row.run_id ? { runId: row.run_id as string } : {}), type: row.type as string, status: row.status as SessionTaskRecord["status"], description: row.description as string, cwd: row.cwd as string, ...(row.output ? { output: row.output as string } : {}), ...(row.error ? { error: row.error as string } : {}), metadata: decode(row.metadata_json as string), createdAt: row.created_at as number, ...(row.started_at ? { startedAt: row.started_at as number } : {}), ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}), updatedAt: row.updated_at as number };
      state.tasks[task.id] = task;
    }
    for (const row of this.database.prepare("SELECT * FROM permission_request").all() as Array<Record<string, unknown>>) {
      const request: PermissionRequestRecord = { id: row.id as string, sessionId: row.session_id as string, ...(row.run_id ? { runId: row.run_id as string } : {}), toolName: row.tool_name as string, payload: decode(row.payload_json as string), status: row.status as PermissionRequestRecord["status"], ...(row.decision ? { decision: row.decision as string } : {}), ...(row.decided_by_client_id ? { decidedByClientId: row.decided_by_client_id as string } : {}), createdAt: row.created_at as number, updatedAt: row.updated_at as number };
      state.permissions[request.id] = request;
    }
    for (const row of this.database.prepare("SELECT * FROM session_event ORDER BY seq").all() as Array<Record<string, unknown>>) {
      const event: SessionEventRecord = { id: row.id as string, seq: row.seq as number, type: row.type as string, ...(row.session_id ? { sessionId: row.session_id as string } : {}), payload: decode(row.payload_json as string), createdAt: row.created_at as number };
      state.events.push(event);
      state.nextEventSeq = Math.max(state.nextEventSeq, event.seq + 1);
    }
    return state;
  }

  private save(): void {
    this.database.transaction(() => {
      this.database.exec("DELETE FROM session_event; DELETE FROM permission_request; DELETE FROM session_task; DELETE FROM session_run; DELETE FROM session_message_part; DELETE FROM session_message; DELETE FROM session_input; DELETE FROM session;");
      const insertSession = this.database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const value of Object.values(this.state.sessions)) insertSession.run(value.id, value.parentId ?? null, value.cwd, value.title, value.model, value.agent ?? null, value.status, encode(value.metadata), value.createdAt, value.updatedAt, value.archivedAt ?? null);
      const insertInput = this.database.prepare("INSERT INTO session_input VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const value of Object.values(this.state.inputs)) insertInput.run(value.id, value.sessionId, value.seq, value.delivery, value.content, encode(value.metadata), value.createdAt);
      const insertMessage = this.database.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const value of Object.values(this.state.messages)) insertMessage.run(value.id, value.sessionId, value.seq, value.role, value.runId ?? null, value.inputId ?? null, encode(value.metadata), value.createdAt, value.updatedAt);
      const insertPart = this.database.prepare("INSERT INTO session_message_part VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const value of Object.values(this.state.parts)) insertPart.run(value.id, value.sessionId, value.messageId, value.seq, value.type, value.status, value.text ?? null, value.toolUseId ?? null, value.toolName ?? null, value.input === undefined ? null : encode(value.input), value.output === undefined ? null : JSON.stringify(value.output), value.isError === undefined ? null : Number(value.isError), encode(value.metadata), value.createdAt, value.updatedAt);
      const insertRun = this.database.prepare("INSERT INTO session_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const value of Object.values(this.state.runs)) insertRun.run(value.id, value.sessionId, value.inputId ?? null, value.status, value.startedAt ?? null, value.finishedAt ?? null, value.error ?? null, encode(value.metadata), value.createdAt, value.updatedAt);
      const insertTask = this.database.prepare("INSERT INTO session_task VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const value of Object.values(this.state.tasks)) insertTask.run(value.id, value.sessionId, value.childSessionId ?? null, value.runId ?? null, value.type, value.status, value.description, value.cwd, value.output ?? null, value.error ?? null, encode(value.metadata), value.createdAt, value.startedAt ?? null, value.finishedAt ?? null, value.updatedAt);
      const insertPermission = this.database.prepare("INSERT INTO permission_request VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const value of Object.values(this.state.permissions)) insertPermission.run(value.id, value.sessionId, value.runId ?? null, value.toolName, encode(value.payload), value.status, value.decision ?? null, value.decidedByClientId ?? null, value.createdAt, value.updatedAt);
      const insertEvent = this.database.prepare("INSERT INTO session_event VALUES (?, ?, ?, ?, ?, ?)");
      for (const value of this.state.events) insertEvent.run(value.id, value.seq, value.type, value.sessionId ?? null, encode(value.payload), value.createdAt);
    })();
  }
}
