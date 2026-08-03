CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, parent_id TEXT, cwd TEXT NOT NULL, title TEXT NOT NULL,
  model TEXT NOT NULL, agent TEXT, status TEXT NOT NULL, metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS session_input (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, delivery TEXT NOT NULL,
  content TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS session_message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
  run_id TEXT, input_id TEXT, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, UNIQUE(session_id, seq)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS session_message_part (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, status TEXT NOT NULL, text TEXT, tool_use_id TEXT, tool_name TEXT,
  input_json TEXT, output_json TEXT, is_error INTEGER, metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(session_id, seq)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS session_run (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, input_id TEXT UNIQUE, status TEXT NOT NULL,
  started_at INTEGER, finished_at INTEGER, error TEXT, metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS session_task (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, child_session_id TEXT, run_id TEXT,
  type TEXT NOT NULL, status TEXT NOT NULL, description TEXT NOT NULL, cwd TEXT NOT NULL,
  output TEXT, error TEXT, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS permission_request (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, tool_name TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL, decision TEXT, decided_by_client_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS session_event (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, type TEXT NOT NULL, session_id TEXT,
  payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS session_parent_idx ON session(parent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS session_cwd_updated_idx ON session(cwd, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS session_input_session_idx ON session_input(session_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS session_message_session_idx ON session_message(session_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS session_part_message_idx ON session_message_part(message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS session_run_session_idx ON session_run(session_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS session_task_session_idx ON session_task(session_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS permission_session_status_idx ON permission_request(session_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS session_event_session_seq_idx ON session_event(session_id, seq);
