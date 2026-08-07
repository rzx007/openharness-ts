import type {
  ReplaceTranscriptMessageInput,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
} from "@openharness/services";

import type { SessionRuntimeInspect } from "./settings-api.js";
import type { RuntimeHostPort } from "./runtime-host.js";

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
  runPrompt(input: SessionRuntimeRunInput, host: RuntimeHostPort): Promise<SessionRuntimeRunResult>;
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

export interface ChildSessionHost {
  createChildSession(input: {
    id?: string;
    parentId: string;
    cwd: string;
    model?: string;
    title: string;
    agent: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionRecord>;
  admitPrompt(sessionId: string, content: string): Promise<{ runId?: string }>;
  awaitRun(
    sessionId: string,
    runId: string,
  ): Promise<{
    status: Extract<SessionRunRecord["status"], "completed" | "failed" | "interrupted">;
    output: string;
    error?: string;
  }>;
  interrupt(sessionId: string): Promise<void>;
  closeRuntime(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
}

/**
 * Runtime-facing bridge for child-agent tasks. The server supplies it so child
 * execution can keep its local TaskManager while lifecycle facts remain durable.
 */
export interface SessionTaskBridge {
  registerSessionTask(input: {
    description: string;
    cwd: string;
    sessionId: string;
    childSessionId: string;
    prompt: string;
    onInput(data: string): Promise<void>;
    onStop(): Promise<void>;
  }): { id: string };
  bindSessionTaskRun(taskId: string, runId: string): Promise<void>;
  completeSessionTask(
    taskId: string,
    input: { status: "completed" | "failed" | "stopped" | "interrupted"; output: string },
  ): Promise<unknown>;
  writeToSessionTask(taskId: string, data: string): Promise<void>;
}

export interface SessionRuntimeFactory {
  createRuntime(context: {
    session: SessionRecord;
    history: SessionMessageRecord[];
    parts: SessionMessagePartRecord[];
  }): Promise<SessionRuntime>;
}
