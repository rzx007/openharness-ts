import type { StreamEvent } from "@openharness/core";

export interface RuntimeHostScope {
  sessionId: string;
  runId: string;
  inputId: string;
  cwd: string;
  traceId: string;
  signal: AbortSignal;
}

export interface RuntimeHostEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface PermissionRequestInput {
  toolName: string;
  reason?: string;
  input?: Record<string, unknown>;
}

export interface PermissionDecision {
  status: "approved" | "denied" | "expired";
  decision?: "once" | "session";
  reason?: string;
}

export interface ChildAgentSpawnInput {
  description: string;
  prompt: string;
  agent: string;
  team?: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: "default" | "plan" | "full_auto";
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  effort?: string;
  isolate?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChildAgentInput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ChildAgentResult {
  status: "completed" | "failed" | "interrupted" | "stopped";
  output: string;
  error?: string;
}

export interface ChildAgentInvocation {
  id: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  result: Promise<ChildAgentResult>;
  worktree?: { path: string; branch: string };
  notice?: string;
}

export interface RuntimeChildAgentHost {
  spawnChildAgent(input: ChildAgentSpawnInput): Promise<ChildAgentInvocation>;
  sendChildInput(invocationId: string, input: ChildAgentInput): Promise<void>;
  interruptChildAgent(invocationId: string, reason?: string): Promise<void>;
  awaitChildAgent(invocationId: string): Promise<ChildAgentResult>;
}

/**
 * Run-scoped boundary for capabilities owned by the host environment.
 */
export interface RuntimeHostPort extends RuntimeChildAgentHost {
  readonly scope: RuntimeHostScope;

  emitEvent(event: RuntimeHostEvent): void | Promise<void>;
  emitStreamEvent(event: StreamEvent): void | Promise<void>;
  requestPermission(input: PermissionRequestInput): Promise<PermissionDecision>;
}
