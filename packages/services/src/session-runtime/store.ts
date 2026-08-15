import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type {
  AdmitPromptInput,
  AppendEventInput,
  AppendMessagePartDeltaInput,
  CreateCronRunInput,
  CreateMessageInput,
  CreatePermissionRequestInput,
  CreateRunInput,
  CreateSessionTaskInput,
  CreateSessionInput,
  CronJobRecord,
  CronRunRecord,
  CronRunStatus,
  ListEventsOptions,
  ListMessagePartsOptions,
  ListMessagesOptions,
  ListPermissionRequestsOptions,
  ListSessionsOptions,
  PermissionRequestRecord,
  ProjectRecord,
  ReplyPermissionInput,
  SessionMessagePartRecord,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionTaskRecord,
  SessionStateSnapshot,
  UpsertCronJobInput,
  UpsertMessagePartInput,
  UpdateCronJobInput,
  UpdateRunInput,
  UpdateSessionTaskInput,
  UpdateSessionInput,
  ReplaceTranscriptInput,
} from "./types.js";
import { formatSessionTitle, isPlaceholderSessionTitle } from "./title.js";

import {
  DEFAULT_DELTA_FLUSH_BYTES,
  DEFAULT_DELTA_FLUSH_INTERVAL_MS,
  EVENT_SEQUENCE_BLOCK_SIZE,
  assertMessage,
  assertMutableSession,
  assertSession,
  clone,
  cloneMutations,
  cronJobFromRow,
  cronRunFromRow,
  decode,
  emptyMutations,
  emptyState,
  encode,
  isDurableEvent,
  isTerminalRunStatus,
  maxSeq,
  now,
  type SessionStoreOptions,
  type SessionState,
  type StoreMutations,
} from "./store-state.js";

export type { SessionStoreOptions } from "./store-state.js";

export class SessionStore {
  readonly path: string;
  private readonly database: Database.Database;
  private closed = false;
  private transactionDepth = 0;
  private saveRequested = false;
  private readonly deltaFlushIntervalMs: number;
  private readonly deltaFlushBytes: number;
  private readonly dirtyDeltaPartIds = new Set<string>();
  private pendingDeltaBytes = 0;
  private deltaFlushTimer?: ReturnType<typeof setTimeout>;
  private reservedEventSeq = 0;
  private mutations = emptyMutations();
  private state: SessionState;

  constructor(options: SessionStoreOptions) {
    this.path = resolve(options.path);
    this.deltaFlushIntervalMs = Math.max(1, options.deltaFlushIntervalMs ?? DEFAULT_DELTA_FLUSH_INTERVAL_MS);
    this.deltaFlushBytes = Math.max(1, options.deltaFlushBytes ?? DEFAULT_DELTA_FLUSH_BYTES);
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
    try {
      this.flushMessagePartDeltas();
    } finally {
      this.clearDeltaFlushTimer();
      this.database.close();
      this.closed = true;
    }
  }

  listProjects(options: { includeArchived?: boolean } = {}): ProjectRecord[] {
    const where = options.includeArchived ? "" : "WHERE p.archived_at IS NULL";
    return (this.database.prepare(`SELECT p.*, l.path FROM project p JOIN project_location l ON l.project_id = p.id AND l.status = 'active' ${where} ORDER BY (p.pinned_at IS NULL), p.pinned_at DESC, p.last_opened_at DESC`).all() as Array<Record<string, unknown>>).map(projectFromRow);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const row = this.database.prepare("SELECT p.*, l.path FROM project p JOIN project_location l ON l.project_id = p.id AND l.status = 'active' WHERE p.id = ?").get(projectId) as Record<string, unknown> | undefined;
    return row ? projectFromRow(row) : undefined;
  }

  inspectProject(inputPath: string): ProjectRecord {
    const path = resolve(inputPath);
    const normalizedPath = normalizeProjectPath(path);
    const row = this.database.prepare("SELECT p.*, l.path FROM project p JOIN project_location l ON l.project_id = p.id AND l.status = 'active' WHERE l.normalized_path = ?").get(normalizedPath) as Record<string, unknown> | undefined;
    const timestamp = now();
    if (row) {
      this.database.prepare("UPDATE project SET archived_at = NULL, last_opened_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, row.id);
      this.database.prepare("UPDATE project_location SET last_verified_at = ? WHERE project_id = ? AND status = 'active'").run(timestamp, row.id);
      return this.getProject(row.id as string)!;
    }
    const projectId = randomUUID();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO project VALUES (?, ?, NULL, ?, NULL, ?, ?)").run(projectId, basename(path), timestamp, timestamp, timestamp);
      this.database.prepare("INSERT INTO project_location VALUES (?, ?, ?, ?, 'active', ?, ?)").run(randomUUID(), projectId, path, normalizedPath, timestamp, timestamp);
    })();
    return this.getProject(projectId)!;
  }

  renameProject(projectId: string, name: string): ProjectRecord {
    const value = name.replace(/\s+/g, " ").trim();
    if (!value) throw new Error("Project name is required");
    if (this.database.prepare("UPDATE project SET name = ?, updated_at = ? WHERE id = ?").run(value, now(), projectId).changes === 0) throw new Error(`Project not found: ${projectId}`);
    return this.getProject(projectId)!;
  }

  setProjectPinned(projectId: string, pinned: boolean): ProjectRecord {
    if (this.database.prepare("UPDATE project SET pinned_at = ?, updated_at = ? WHERE id = ?").run(pinned ? now() : null, now(), projectId).changes === 0) throw new Error(`Project not found: ${projectId}`);
    return this.getProject(projectId)!;
  }

  archiveProject(projectId: string): ProjectRecord {
    const timestamp = now();
    if (this.database.prepare("UPDATE project SET archived_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, projectId).changes === 0) throw new Error(`Project not found: ${projectId}`);
    return this.getProject(projectId)!;
  }

  rebindProject(projectId: string, inputPath: string): ProjectRecord {
    const existing = this.getProject(projectId);
    if (!existing) throw new Error(`Project not found: ${projectId}`);
    const previousPath = existing.path;
    const path = resolve(inputPath);
    const normalizedPath = normalizeProjectPath(path);
    const conflict = this.database.prepare("SELECT project_id FROM project_location WHERE normalized_path = ? AND status = 'active'").get(normalizedPath) as { project_id?: string } | undefined;
    if (conflict?.project_id && conflict.project_id !== projectId) throw new Error("Project directory is already bound to another project");
    const timestamp = now();
    const rewrittenSessions: SessionRecord[] = [];
    this.database.transaction(() => {
      this.database.prepare("UPDATE project_location SET status = 'historical' WHERE project_id = ? AND status = 'active'").run(projectId);
      this.database.prepare("INSERT INTO project_location VALUES (?, ?, ?, ?, 'active', ?, ?)").run(randomUUID(), projectId, path, normalizedPath, timestamp, timestamp);
      this.database.prepare("UPDATE project SET archived_at = NULL, last_opened_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, projectId);
      for (const session of Object.values(this.state.sessions)) {
        if (session.projectId !== projectId) continue;
        // Isolated worktrees and other out-of-tree cwds keep their absolute path.
        if (!isPathInsideOrEqual(previousPath, session.cwd)) continue;
        session.cwd = resolve(path, relative(previousPath, session.cwd));
        session.cwdRelative = relative(path, session.cwd);
        session.updatedAt = timestamp;
        this.database.prepare("UPDATE session SET cwd = ?, cwd_relative = ?, updated_at = ? WHERE id = ?")
          .run(session.cwd, session.cwdRelative, timestamp, session.id);
        rewrittenSessions.push(session);
      }
    })();
    for (const session of rewrittenSessions) {
      this.appendEventInMemory({
        type: "session.updated",
        sessionId: session.id,
        payload: { session: clone(session) },
      });
    }
    if (rewrittenSessions.length > 0) this.save();
    return this.getProject(projectId)!;
  }

  upsertCronJob(input: UpsertCronJobInput): CronJobRecord {
    const existing = this.getCronJobByName(input.name);
    const timestamp = now();
    const record: CronJobRecord = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name: input.name,
      expression: input.expression,
      command: input.command,
      cwd: input.cwd,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      enabled: input.enabled ?? existing?.enabled ?? true,
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(input.nextRunAt ? { nextRunAt: input.nextRunAt } : {}),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.database.prepare(`
      INSERT INTO cron_job (
        id, name, expression, command, cwd, timezone, enabled,
        last_run_at, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        expression = excluded.expression,
        command = excluded.command,
        cwd = excluded.cwd,
        timezone = excluded.timezone,
        enabled = excluded.enabled,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at
    `).run(
      record.id, record.name, record.expression, record.command, record.cwd,
      record.timezone ?? null, record.enabled ? 1 : 0, record.lastRunAt ?? null,
      record.nextRunAt ?? null, record.createdAt, record.updatedAt,
    );
    return this.getCronJobByName(record.name)!;
  }

  getCronJob(id: string): CronJobRecord | undefined {
    const row = this.database.prepare("SELECT * FROM cron_job WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? cronJobFromRow(row) : undefined;
  }

  getCronJobByName(name: string): CronJobRecord | undefined {
    const row = this.database.prepare("SELECT * FROM cron_job WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    return row ? cronJobFromRow(row) : undefined;
  }

  listCronJobs(): CronJobRecord[] {
    return (this.database.prepare("SELECT * FROM cron_job ORDER BY name").all() as Array<Record<string, unknown>>)
      .map(cronJobFromRow);
  }

  updateCronJob(id: string, patch: UpdateCronJobInput): CronJobRecord {
    const current = this.getCronJob(id);
    if (!current) throw new Error(`Cron job not found: ${id}`);
    const updated: CronJobRecord = {
      ...current,
      ...(patch.expression !== undefined ? { expression: patch.expression } : {}),
      ...(patch.command !== undefined ? { command: patch.command } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: now(),
    };
    if (patch.timezone !== undefined) {
      if (patch.timezone === null) delete updated.timezone;
      else updated.timezone = patch.timezone;
    }
    if (patch.lastRunAt !== undefined) {
      if (patch.lastRunAt === null) delete updated.lastRunAt;
      else updated.lastRunAt = patch.lastRunAt;
    }
    if (patch.nextRunAt !== undefined) {
      if (patch.nextRunAt === null) delete updated.nextRunAt;
      else updated.nextRunAt = patch.nextRunAt;
    }
    this.database.prepare(`
      UPDATE cron_job SET expression = ?, command = ?, cwd = ?, timezone = ?, enabled = ?,
        last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?
    `).run(
      updated.expression, updated.command, updated.cwd, updated.timezone ?? null,
      updated.enabled ? 1 : 0, updated.lastRunAt ?? null, updated.nextRunAt ?? null,
      updated.updatedAt, id,
    );
    return updated;
  }

  deleteCronJob(id: string): boolean {
    return this.database.prepare("DELETE FROM cron_job WHERE id = ?").run(id).changes > 0;
  }

  createCronRun(input: CreateCronRunInput): CronRunRecord {
    const record: CronRunRecord = {
      id: input.id ?? randomUUID(),
      jobId: input.jobId,
      jobName: input.jobName,
      cause: input.cause,
      status: "running",
      startedAt: now(),
    };
    this.database.prepare(`
      INSERT INTO cron_run (id, job_id, job_name, cause, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.id, record.jobId, record.jobName, record.cause, record.status, record.startedAt);
    return record;
  }

  finishCronRun(
    id: string,
    result: { status: Exclude<CronRunStatus, "running">; output?: string; error?: string },
  ): CronRunRecord {
    const finishedAt = now();
    this.database.prepare(`
      UPDATE cron_run SET status = ?, output = ?, error = ?, finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(result.status, result.output ?? null, result.error ?? null, finishedAt, id);
    const row = this.database.prepare("SELECT * FROM cron_run WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Cron run not found: ${id}`);
    return cronRunFromRow(row);
  }

  listCronRuns(options: { jobId?: string; jobName?: string; limit?: number } = {}): CronRunRecord[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const rows = options.jobId
      ? this.database.prepare("SELECT * FROM cron_run WHERE job_id = ? ORDER BY started_at DESC LIMIT ?").all(options.jobId, limit)
      : options.jobName
        ? this.database.prepare("SELECT * FROM cron_run WHERE job_name = ? ORDER BY started_at DESC LIMIT ?").all(options.jobName, limit)
      : this.database.prepare("SELECT * FROM cron_run ORDER BY started_at DESC LIMIT ?").all(limit);
    return (rows as Array<Record<string, unknown>>).map(cronRunFromRow);
  }

  interruptActiveCronRuns(reason: string): number {
    return this.database.prepare(`
      UPDATE cron_run SET status = 'interrupted', error = ?, finished_at = ? WHERE status = 'running'
    `).run(reason, now()).changes;
  }

  /**
   * Groups synchronous store mutations into one durable commit. Both SQLite
   * rows and the in-memory read model return to their previous state on error.
   */
  transaction<T>(work: () => T): T {
    const previous = structuredClone(this.state);
    const previousDirtyPartIds = new Set(this.dirtyDeltaPartIds);
    const previousPendingDeltaBytes = this.pendingDeltaBytes;
    const previousSaveRequested = this.saveRequested;
    const previousReservedEventSeq = this.reservedEventSeq;
    const previousMutations = cloneMutations(this.mutations);
    this.transactionDepth += 1;
    if (this.transactionDepth === 1) this.saveRequested = false;
    let persisted = false;
    let completed = false;
    try {
      const result = this.database.transaction(() => {
        const value = work();
        if (this.transactionDepth === 1 && this.saveRequested) {
          this.persistChanges();
          persisted = true;
        }
        return value;
      })();
      if (persisted) {
        this.clearDirtyDeltas();
        this.mutations = emptyMutations();
      }
      completed = true;
      return result;
    } catch (error) {
      this.state = previous;
      this.restoreDirtyDeltas(previousDirtyPartIds, previousPendingDeltaBytes);
      this.saveRequested = previousSaveRequested;
      this.reservedEventSeq = previousReservedEventSeq;
      this.mutations = previousMutations;
      throw error;
    } finally {
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) {
        this.saveRequested = previousSaveRequested;
        if (this.dirtyDeltaPartIds.size > 0) {
          if (completed && this.pendingDeltaBytes >= this.deltaFlushBytes) this.flushMessagePartDeltas();
          else this.scheduleDeltaFlush();
        }
      }
    }
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const id = input.id ?? randomUUID();
    if (this.state.sessions[id]) throw new Error(`Session already exists: ${id}`);
    const timestamp = now();
    const projectId = input.projectId ?? (input.parentId ? this.state.sessions[input.parentId]?.projectId : undefined);
    const project = projectId ? this.getProject(projectId) : this.inspectProject(input.cwd);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const cwd = resolve(input.cwd);
    // Top-level sessions must stay inside the bound project. Child/worktree sessions may live outside.
    if (!input.parentId && !isPathInsideOrEqual(project.path, cwd)) {
      throw new Error(`Session cwd must be inside project directory: ${project.path}`);
    }
    const session: SessionRecord = {
      id,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      projectId: project.id,
      cwd,
      cwdRelative: relative(project.path, cwd),
      title: input.title ?? "",
      model: input.model,
      ...(input.agent ? { agent: input.agent } : {}),
      status: "idle",
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.sessions[id] = session;
    this.mutations.sessions.add(id);
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
    this.mutations.sessions.add(sessionId);
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
    this.mutations.sessions.add(sessionId);
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
    this.mutations.sessions.add(sessionId);
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
    this.mutations.inputs.add(id);
    this.mutations.sessions.add(input.sessionId);
    this.appendEventInMemory({
      type: "session.input.admitted",
      sessionId: input.sessionId,
      payload: { input: row },
    });
    this.save();
    return clone(row);
  }

  /** Respect renamed titles; use the first prompt only for legacy placeholder titles. */
  resolveSessionListTitle(sessionId: string): string {
    const session = assertSession(this.state, sessionId);
    const stored = session.title.trim();
    if (stored && !isPlaceholderSessionTitle(stored)) return formatSessionTitle(stored);
    const first = Object.values(this.state.inputs)
      .filter((input) => input.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq)[0];
    const fromPrompt = first ? formatSessionTitle(first.content) : "";
    if (fromPrompt) return fromPrompt;
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
    this.mutations.messages.add(id);
    this.mutations.sessions.add(input.sessionId);
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
      if (message.sessionId === input.sessionId) {
        delete this.state.messages[id];
        this.mutations.messages.delete(id);
        this.mutations.deletedMessages.add(id);
      }
    }
    for (const [id, part] of Object.entries(this.state.parts)) {
      if (part.sessionId === input.sessionId) {
        delete this.state.parts[id];
        this.mutations.parts.delete(id);
        this.mutations.deletedParts.add(id);
        this.dirtyDeltaPartIds.delete(id);
      }
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
      this.mutations.messages.add(messageId);
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
        this.mutations.parts.add(partId);
        parts.push(part);
      }
    }

    session.updatedAt = timestamp;
    this.mutations.sessions.add(input.sessionId);
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
    this.mutations.parts.add(id);
    this.mutations.messages.add(message.id);
    this.mutations.sessions.add(session.id);
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
    }, false);
    part.text = `${part.text ?? ""}${input.delta}`;
    part.updatedAt = timestamp;
    message.updatedAt = timestamp;
    session.updatedAt = timestamp;
    this.dirtyDeltaPartIds.add(part.id);
    this.pendingDeltaBytes += Buffer.byteLength(input.delta, "utf8");
    if (this.transactionDepth === 0) {
      if (this.pendingDeltaBytes >= this.deltaFlushBytes) this.flushMessagePartDeltas();
      else this.scheduleDeltaFlush();
    }
    return clone(event);
  }

  flushMessagePartDeltas(): void {
    if (this.dirtyDeltaPartIds.size === 0) return;
    const partIds = [...this.dirtyDeltaPartIds];
    const flush = () => this.persistDeltaPartRows(partIds);
    if (this.transactionDepth > 0) flush();
    else this.database.transaction(flush)();
    for (const partId of partIds) this.dirtyDeltaPartIds.delete(partId);
    if (this.dirtyDeltaPartIds.size === 0) {
      this.pendingDeltaBytes = 0;
      this.clearDeltaFlushTimer();
    }
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

  latestEventSeq(): number {
    return this.state.nextEventSeq - 1;
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
    this.mutations.runs.add(id);
    this.mutations.sessions.add(session.id);
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
      if (isTerminalRunStatus(previous) && input.status !== previous) {
        throw new Error(`Session run is already terminal: ${runId}`);
      }
      run.status = input.status;
      if (input.status === "running" && previous !== "running") {
        run.startedAt = timestamp;
        delete run.finishedAt;
        delete run.error;
      }
      if (["completed", "failed", "interrupted"].includes(input.status)) run.finishedAt = timestamp;
    }
    if (input.error !== undefined) run.error = input.error;
    if (input.metadata) run.metadata = { ...run.metadata, ...input.metadata };
    run.updatedAt = timestamp;
    this.refreshSessionStatus(session);
    session.updatedAt = timestamp;
    this.mutations.runs.add(runId);
    this.mutations.sessions.add(session.id);
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
    const direct = Object.values(this.state.runs).find((candidate) => candidate.inputId === inputId);
    if (direct) return clone(direct);
    const promoted = Object.values(this.state.messages).find((message) =>
      message.inputId === inputId && message.runId,
    );
    const run = promoted?.runId ? this.state.runs[promoted.runId] : undefined;
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
    this.mutations.tasks.add(id);
    this.mutations.sessions.add(session.id);
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
      if (input.status === "running" && previousStatus !== "running") {
        task.startedAt = timestamp;
        delete task.finishedAt;
        delete task.output;
        delete task.error;
      }
      if (["completed", "failed", "stopped", "interrupted"].includes(input.status)) task.finishedAt = timestamp;
    }
    if (input.output !== undefined) task.output = input.output;
    if (input.error !== undefined) task.error = input.error;
    if (input.metadata) task.metadata = { ...task.metadata, ...input.metadata };
    task.updatedAt = timestamp;
    session.updatedAt = timestamp;
    this.mutations.tasks.add(taskId);
    this.mutations.sessions.add(session.id);
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
    for (const run of active) {
      const messageIds = new Set(Object.values(this.state.messages)
        .filter((message) => message.runId === run.id)
        .map((message) => message.id));
      for (const part of Object.values(this.state.parts)) {
        if (!messageIds.has(part.messageId) || part.status !== "running") continue;
        this.upsertMessagePart({
          id: part.id,
          sessionId: part.sessionId,
          messageId: part.messageId,
          type: part.type,
          status: "interrupted",
        });
      }
      this.updateRun(run.id, { status: "interrupted", error: reason });
    }
    return active.length;
  }

  /** A previous process cannot retain the resolver behind a pending permission prompt. */
  expirePendingPermissionRequests(reason = "Daemon restarted before the permission was resolved"): number {
    const pending = Object.values(this.state.permissions)
      .filter((request) => request.status === "pending");
    for (const request of pending) {
      this.replyPermission({ requestId: request.id, status: "expired", decision: reason });
    }
    return pending.length;
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
    this.mutations.permissions.add(id);
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
    if (request.status !== "pending") throw new Error(`Permission request already resolved: ${input.requestId}`);
    const timestamp = now();
    request.status = input.status;
    if (input.decision !== undefined) request.decision = input.decision;
    if (input.clientId !== undefined) request.decidedByClientId = input.clientId;
    request.updatedAt = timestamp;
    this.mutations.permissions.add(request.id);
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

  private appendEventInMemory(input: AppendEventInput, retain = true): SessionEventRecord {
    const event: SessionEventRecord = {
      id: input.id ?? randomUUID(),
      seq: this.allocateEventSequence(),
      type: input.type,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      payload: input.payload ?? {},
      createdAt: now(),
    };
    if (retain) {
      this.state.events.push(event);
      this.mutations.events.add(event.id);
    }
    return event;
  }

  private scheduleDeltaFlush(): void {
    if (this.deltaFlushTimer || this.closed || this.dirtyDeltaPartIds.size === 0) return;
    this.deltaFlushTimer = setTimeout(() => {
      this.deltaFlushTimer = undefined;
      try {
        this.flushMessagePartDeltas();
      } catch {
        this.scheduleDeltaFlush();
      }
    }, this.deltaFlushIntervalMs);
    this.deltaFlushTimer.unref?.();
  }

  private clearDeltaFlushTimer(): void {
    if (!this.deltaFlushTimer) return;
    clearTimeout(this.deltaFlushTimer);
    this.deltaFlushTimer = undefined;
  }

  private clearDirtyDeltas(): void {
    this.dirtyDeltaPartIds.clear();
    this.pendingDeltaBytes = 0;
    this.clearDeltaFlushTimer();
  }

  private restoreDirtyDeltas(partIds: Set<string>, pendingBytes: number): void {
    this.dirtyDeltaPartIds.clear();
    for (const partId of partIds) this.dirtyDeltaPartIds.add(partId);
    this.pendingDeltaBytes = pendingBytes;
    this.clearDeltaFlushTimer();
    this.scheduleDeltaFlush();
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
        ...(row.project_id ? { projectId: row.project_id as string } : {}),
        cwd: row.cwd as string,
        ...(row.cwd_relative !== null ? { cwdRelative: row.cwd_relative as string } : {}),
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
    const sequence = this.database.prepare(
      "SELECT reserved_through FROM session_event_sequence WHERE id = 1",
    ).get() as { reserved_through?: number } | undefined;
    this.reservedEventSeq = sequence?.reserved_through ?? 0;
    state.nextEventSeq = Math.max(state.nextEventSeq, this.reservedEventSeq + 1);
    return state;
  }

  private allocateEventSequence(): number {
    if (this.state.nextEventSeq > this.reservedEventSeq) {
      const reservedThrough = this.state.nextEventSeq + EVENT_SEQUENCE_BLOCK_SIZE - 1;
      this.database.prepare(`
        INSERT INTO session_event_sequence (id, reserved_through) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET reserved_through = excluded.reserved_through
      `).run(reservedThrough);
      this.reservedEventSeq = reservedThrough;
    }
    return this.state.nextEventSeq++;
  }

  private save(): void {
    if (this.transactionDepth > 0) {
      this.saveRequested = true;
      return;
    }
    try {
      this.database.transaction(() => this.persistChanges())();
      this.clearDirtyDeltas();
      this.mutations = emptyMutations();
    } catch (error) {
      this.state = this.load();
      this.clearDirtyDeltas();
      this.mutations = emptyMutations();
      throw error;
    }
  }

  private persistChanges(): void {
    if (this.dirtyDeltaPartIds.size > 0) this.persistDeltaPartRows([...this.dirtyDeltaPartIds]);

    const deletePart = this.database.prepare("DELETE FROM session_message_part WHERE id = ?");
    for (const id of this.mutations.deletedParts) deletePart.run(id);
    const deleteMessage = this.database.prepare("DELETE FROM session_message WHERE id = ?");
    for (const id of this.mutations.deletedMessages) deleteMessage.run(id);

    const upsertSession = this.database.prepare(`
      INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, cwd=excluded.cwd,
        project_id=excluded.project_id, cwd_relative=excluded.cwd_relative,
        title=excluded.title, model=excluded.model, agent=excluded.agent, status=excluded.status,
        metadata_json=excluded.metadata_json, created_at=excluded.created_at,
        updated_at=excluded.updated_at, archived_at=excluded.archived_at
    `);
    for (const id of this.mutations.sessions) {
      const value = this.state.sessions[id];
      if (value) upsertSession.run(value.id, value.parentId ?? null, value.cwd, value.title, value.model, value.agent ?? null, value.status, encode(value.metadata), value.createdAt, value.updatedAt, value.archivedAt ?? null, value.projectId ?? null, value.cwdRelative ?? null);
    }

    const upsertInput = this.database.prepare(`
      INSERT INTO session_input VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, seq=excluded.seq,
        delivery=excluded.delivery, content=excluded.content, metadata_json=excluded.metadata_json,
        created_at=excluded.created_at
    `);
    for (const id of this.mutations.inputs) {
      const value = this.state.inputs[id];
      if (value) upsertInput.run(value.id, value.sessionId, value.seq, value.delivery, value.content, encode(value.metadata), value.createdAt);
    }

    const upsertMessage = this.database.prepare(`
      INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, seq=excluded.seq,
        role=excluded.role, run_id=excluded.run_id, input_id=excluded.input_id,
        metadata_json=excluded.metadata_json, created_at=excluded.created_at, updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.messages) {
      const value = this.state.messages[id];
      if (value) upsertMessage.run(value.id, value.sessionId, value.seq, value.role, value.runId ?? null, value.inputId ?? null, encode(value.metadata), value.createdAt, value.updatedAt);
    }

    const upsertPart = this.database.prepare(`
      INSERT INTO session_message_part VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, message_id=excluded.message_id,
        seq=excluded.seq, type=excluded.type, status=excluded.status, text=excluded.text,
        tool_use_id=excluded.tool_use_id, tool_name=excluded.tool_name, input_json=excluded.input_json,
        output_json=excluded.output_json, is_error=excluded.is_error, metadata_json=excluded.metadata_json,
        created_at=excluded.created_at, updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.parts) {
      const value = this.state.parts[id];
      if (value) upsertPart.run(value.id, value.sessionId, value.messageId, value.seq, value.type, value.status, value.text ?? null, value.toolUseId ?? null, value.toolName ?? null, value.input === undefined ? null : encode(value.input), value.output === undefined ? null : JSON.stringify(value.output), value.isError === undefined ? null : Number(value.isError), encode(value.metadata), value.createdAt, value.updatedAt);
    }

    const upsertRun = this.database.prepare(`
      INSERT INTO session_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, input_id=excluded.input_id,
        status=excluded.status, started_at=excluded.started_at, finished_at=excluded.finished_at,
        error=excluded.error, metadata_json=excluded.metadata_json, created_at=excluded.created_at,
        updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.runs) {
      const value = this.state.runs[id];
      if (value) upsertRun.run(value.id, value.sessionId, value.inputId ?? null, value.status, value.startedAt ?? null, value.finishedAt ?? null, value.error ?? null, encode(value.metadata), value.createdAt, value.updatedAt);
    }

    const upsertTask = this.database.prepare(`
      INSERT INTO session_task VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,
        child_session_id=excluded.child_session_id, run_id=excluded.run_id, type=excluded.type,
        status=excluded.status, description=excluded.description, cwd=excluded.cwd,
        output=excluded.output, error=excluded.error, metadata_json=excluded.metadata_json,
        created_at=excluded.created_at, started_at=excluded.started_at,
        finished_at=excluded.finished_at, updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.tasks) {
      const value = this.state.tasks[id];
      if (value) upsertTask.run(value.id, value.sessionId, value.childSessionId ?? null, value.runId ?? null, value.type, value.status, value.description, value.cwd, value.output ?? null, value.error ?? null, encode(value.metadata), value.createdAt, value.startedAt ?? null, value.finishedAt ?? null, value.updatedAt);
    }

    const upsertPermission = this.database.prepare(`
      INSERT INTO permission_request VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, run_id=excluded.run_id,
        tool_name=excluded.tool_name, payload_json=excluded.payload_json, status=excluded.status,
        decision=excluded.decision, decided_by_client_id=excluded.decided_by_client_id,
        created_at=excluded.created_at, updated_at=excluded.updated_at
    `);
    for (const id of this.mutations.permissions) {
      const value = this.state.permissions[id];
      if (value) upsertPermission.run(value.id, value.sessionId, value.runId ?? null, value.toolName, encode(value.payload), value.status, value.decision ?? null, value.decidedByClientId ?? null, value.createdAt, value.updatedAt);
    }

    const insertEvent = this.database.prepare("INSERT INTO session_event VALUES (?, ?, ?, ?, ?, ?)");
    for (const value of this.state.events) {
      if (!this.mutations.events.has(value.id) || !isDurableEvent(value)) continue;
      insertEvent.run(value.id, value.seq, value.type, value.sessionId ?? null, encode(value.payload), value.createdAt);
    }
  }

  private persistDeltaPartRows(partIds: string[]): void {
    const updatePart = this.database.prepare("UPDATE session_message_part SET text = ?, updated_at = ? WHERE id = ?");
    const updateMessage = this.database.prepare("UPDATE session_message SET updated_at = ? WHERE id = ?");
    const updateSession = this.database.prepare("UPDATE session SET updated_at = ? WHERE id = ?");
    const messageIds = new Set<string>();
    const sessionIds = new Set<string>();
    for (const partId of partIds) {
      const part = this.state.parts[partId];
      if (!part) continue;
      updatePart.run(part.text ?? "", part.updatedAt, part.id);
      messageIds.add(part.messageId);
      sessionIds.add(part.sessionId);
    }
    for (const messageId of messageIds) {
      const message = this.state.messages[messageId];
      if (message) updateMessage.run(message.updatedAt, message.id);
    }
    for (const sessionId of sessionIds) {
      const session = this.state.sessions[sessionId];
      if (session) updateSession.run(session.updatedAt, session.id);
    }
  }

}

function projectFromRow(row: Record<string, unknown>): ProjectRecord {
  return { id: row.id as string, name: row.name as string, path: row.path as string,
    ...(row.pinned_at ? { pinnedAt: row.pinned_at as number } : {}), lastOpenedAt: row.last_opened_at as number,
    ...(row.archived_at ? { archivedAt: row.archived_at as number } : {}), createdAt: row.created_at as number, updatedAt: row.updated_at as number };
}

function normalizeProjectPath(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

/** True when target is the root itself or a path under root (no .. escape). */
export function isPathInsideOrEqual(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
