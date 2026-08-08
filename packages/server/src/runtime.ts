import type {
  ReplaceTranscriptMessageInput,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@openharness/services/session-runtime/types";
import type { AgentRunHost } from "@openharness/core";

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
  /** Pull admitted steer inputs not yet bound to a run; safe to call at turn boundaries. */
  drainSteeredInputs(): SessionInputRecord[];
}

export interface SessionRuntimeRunResult {
  messages: RuntimeMessageRecord[];
}

export interface SessionRuntime {
  runPrompt(input: SessionRuntimeRunInput, host: AgentRunHost): Promise<SessionRuntimeRunResult>;
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
