import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  AdmitPromptInput,
  AppendEventInput,
  AppendMessagePartDeltaInput,
  CreateMessageInput,
  CreatePermissionRequestInput,
  CreateRunInput,
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
  SessionStateSnapshot,
  UpsertMessagePartInput,
  UpdateRunInput,
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
    permissions: {},
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
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

function assertMessage(state: SessionState, messageId: string): SessionMessageRecord {
  const message = state.messages[messageId];
  if (!message) throw new Error(`Session message not found: ${messageId}`);
  return message;
}

export class SessionStore {
  readonly path: string;
  private state: SessionState;

  constructor(options: SessionStoreOptions) {
    this.path = resolve(options.path);
    this.state = this.load();
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

  archiveSession(sessionId: string): SessionRecord {
    const session = assertSession(this.state, sessionId);
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

  updateSession(sessionId: string, input: UpdateSessionInput): SessionRecord {
    const session = assertSession(this.state, sessionId);
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
    if (input.inputId && !this.state.inputs[input.inputId]) {
      throw new Error(`Session input not found: ${input.inputId}`);
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
    session.status = run.status === "running" ? "running" : "idle";
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

  listRuns(sessionId: string): SessionRunRecord[] {
    assertSession(this.state, sessionId);
    return clone(Object.values(this.state.runs)
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt));
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

  private load(): SessionState {
    if (!existsSync(this.path)) return emptyState();
    const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<SessionState>;
    return {
      nextEventSeq: parsed.nextEventSeq ?? 1,
      sessions: parsed.sessions ?? {},
      inputs: parsed.inputs ?? {},
      messages: parsed.messages ?? {},
      parts: parsed.parts ?? {},
      events: parsed.events ?? [],
      runs: parsed.runs ?? {},
      permissions: parsed.permissions ?? {},
    };
  }

  private save(): void {
    atomicWrite(this.path, JSON.stringify(this.state, null, 2) + "\n");
  }
}
