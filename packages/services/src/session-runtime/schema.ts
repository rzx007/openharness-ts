import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("session", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"),
  cwd: text("cwd").notNull(),
  title: text("title").notNull(),
  model: text("model").notNull(),
  agent: text("agent"),
  status: text("status").notNull(),
  metadataJson: text("metadata_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  archivedAt: integer("archived_at"),
}, (table) => [
  index("session_parent_idx").on(table.parentId),
  index("session_cwd_updated_idx").on(table.cwd, table.updatedAt),
]);

export const sessionInputs = sqliteTable("session_input", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  delivery: text("delivery").notNull(),
  content: text("content").notNull(),
  metadataJson: text("metadata_json").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("session_input_session_seq").on(table.sessionId, table.seq),
  index("session_input_session_idx").on(table.sessionId),
]);

export const sessionMessages = sqliteTable("session_message", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  role: text("role").notNull(),
  runId: text("run_id"),
  inputId: text("input_id"),
  metadataJson: text("metadata_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("session_message_session_seq").on(table.sessionId, table.seq),
  index("session_message_session_idx").on(table.sessionId),
]);

export const sessionMessageParts = sqliteTable("session_message_part", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  messageId: text("message_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  text: text("text"),
  toolUseId: text("tool_use_id"),
  toolName: text("tool_name"),
  inputJson: text("input_json"),
  outputJson: text("output_json"),
  isError: integer("is_error"),
  metadataJson: text("metadata_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("session_part_session_seq").on(table.sessionId, table.seq),
  index("session_part_message_idx").on(table.messageId),
]);

export const sessionRuns = sqliteTable("session_run", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  inputId: text("input_id"),
  status: text("status").notNull(),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  error: text("error"),
  metadataJson: text("metadata_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("session_run_session_idx").on(table.sessionId, table.createdAt),
  uniqueIndex("session_run_input_unique").on(table.inputId),
]);

export const sessionTasks = sqliteTable("session_task", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  childSessionId: text("child_session_id"),
  runId: text("run_id"),
  type: text("type").notNull(),
  status: text("status").notNull(),
  description: text("description").notNull(),
  cwd: text("cwd").notNull(),
  output: text("output"),
  error: text("error"),
  metadataJson: text("metadata_json").notNull(),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("session_task_session_idx").on(table.sessionId, table.createdAt),
]);

export const permissionRequests = sqliteTable("permission_request", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  runId: text("run_id"),
  toolName: text("tool_name").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull(),
  decision: text("decision"),
  decidedByClientId: text("decided_by_client_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("permission_session_status_idx").on(table.sessionId, table.status),
]);

export const sessionEvents = sqliteTable("session_event", {
  id: text("id").primaryKey(),
  seq: integer("seq").notNull().unique(),
  type: text("type").notNull(),
  sessionId: text("session_id"),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("session_event_session_seq_idx").on(table.sessionId, table.seq),
]);

export const sessionEventSequence = sqliteTable("session_event_sequence", {
  id: integer("id").primaryKey(),
  reservedThrough: integer("reserved_through").notNull(),
});
