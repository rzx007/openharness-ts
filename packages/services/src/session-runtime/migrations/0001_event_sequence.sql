CREATE TABLE IF NOT EXISTS session_event_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reserved_through INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO session_event_sequence (id, reserved_through)
VALUES (1, 0)
ON CONFLICT(id) DO NOTHING;
