import type { StreamEvent } from "@openharness/core";
import type {
  ReplaceTranscriptMessageInput,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@openharness/services";

import type { SessionRuntimeInspect } from "./settings-api.js";

export interface SessionCompactResult {
  messageCount: number;
  transcript: ReplaceTranscriptMessageInput[];
}

export interface SessionRememberResult {
  skipped: boolean;
  reason?: string;
  writtenIds: string[];
  titles: string[];
}

export interface SessionUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  messageCount: number;
}

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
  /** Optional inspection surface for session-scoped resources (MCP, etc.). */
  inspect?(): Promise<SessionRuntimeInspect> | SessionRuntimeInspect;
  /** Compact in-memory engine history; caller must persist via store.replaceTranscript. */
  compact?(): Promise<SessionCompactResult>;
  /** Extract durable memories from the current session history. */
  remember?(): Promise<SessionRememberResult>;
  /** Token usage accumulated by the warm QueryEngine for this session runtime. */
  getUsage?(): Promise<SessionUsageSnapshot> | SessionUsageSnapshot;
}

export interface SessionRuntimeFactory {
  createRuntime(context: {
    session: SessionRecord;
    history: SessionMessageRecord[];
    parts: SessionMessagePartRecord[];
  }): Promise<SessionRuntime>;
}
