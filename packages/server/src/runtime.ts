import type { StreamEvent } from "@openharness/core";
import type {
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@openharness/services";

export interface RuntimeMessageRecord {
  role: string;
  content: unknown;
  metadata?: Record<string, unknown>;
}

export interface SessionRuntimeRunInput {
  session: SessionRecord;
  input: SessionInputRecord;
  runId: string;
  history: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
  signal: AbortSignal;
  wakeCount(): number;
}

export interface RuntimePermissionAskInput {
  toolName: string;
  reason?: string;
  input?: Record<string, unknown>;
}

export interface SessionRuntimeHooks {
  onEvent(event: { type: string; payload?: Record<string, unknown> }): void | Promise<void>;
  onStreamEvent(event: StreamEvent): void | Promise<void>;
  askPermission(input: RuntimePermissionAskInput): Promise<boolean>;
}

export interface SessionRuntimeRunResult {
  messages: RuntimeMessageRecord[];
}

export interface SessionRuntime {
  runPrompt(input: SessionRuntimeRunInput, hooks: SessionRuntimeHooks): Promise<SessionRuntimeRunResult>;
  close(): Promise<void>;
}

export interface SessionRuntimeFactory {
  createRuntime(context: {
    session: SessionRecord;
    history: SessionMessageRecord[];
    parts: SessionMessagePartRecord[];
  }): Promise<SessionRuntime>;
}
