import type { StreamingMessageClient } from "./client";
import type { ToolRegistry } from "./tools";
import type { PermissionChecker } from "./permissions";
import type { HookExecutor } from "./hooks";
import type { ContentBlock, Message } from "./messages";
import type { StreamEvent } from "./events";
import type { Settings } from "./settings";
import type { CompactAttachmentsProvider } from "../engine/compact-service";

export interface QueryRuntimeHostEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface QueryRuntimePermissionRequest {
  toolName: string;
  reason?: string;
  input?: Record<string, unknown>;
}

export interface QueryRuntimePermissionDecision {
  status: "approved" | "denied" | "expired";
  decision?: "once" | "session";
  reason?: string;
}

export interface QueryRuntimeChildAgentSpawnInput {
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

export interface QueryRuntimeChildAgentInput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface QueryRuntimeChildAgentResult {
  status: "completed" | "failed" | "interrupted" | "stopped";
  output: string;
  error?: string;
}

export interface QueryRuntimeChildAgentInvocation {
  id: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  result: Promise<QueryRuntimeChildAgentResult>;
  worktree?: { path: string; branch: string };
  notice?: string;
}

export interface QueryRuntimeChildAgentHost {
  spawnChildAgent(input: QueryRuntimeChildAgentSpawnInput): Promise<QueryRuntimeChildAgentInvocation>;
  sendChildInput(invocationId: string, input: QueryRuntimeChildAgentInput): Promise<void>;
  interruptChildAgent(invocationId: string, reason?: string): Promise<void>;
  awaitChildAgent(invocationId: string): Promise<QueryRuntimeChildAgentResult>;
}

export interface QueryRuntimeHost extends QueryRuntimeChildAgentHost {
  emitEvent(event: QueryRuntimeHostEvent): void | Promise<void>;
  requestPermission(input: QueryRuntimePermissionRequest): Promise<QueryRuntimePermissionDecision>;
}

export interface AgentRunScope {
  sessionId: string;
  runId: string;
  inputId: string;
  cwd: string;
  traceId: string;
  signal: AbortSignal;
}

export type AgentRuntimeEvent = QueryRuntimeHostEvent;
export type AgentPermissionRequest = QueryRuntimePermissionRequest;
export type AgentPermissionDecision = QueryRuntimePermissionDecision;
export type AgentChildAgentSpawnInput = QueryRuntimeChildAgentSpawnInput;
export type AgentChildAgentInput = QueryRuntimeChildAgentInput;
export type AgentChildAgentResult = QueryRuntimeChildAgentResult;
export type AgentChildAgentInvocation = QueryRuntimeChildAgentInvocation;
export type AgentChildAgentHost = QueryRuntimeChildAgentHost;

/**
 * Run-scoped boundary for capabilities owned by the host environment.
 *
 * Framework code defines this contract; applications such as the daemon decide
 * how to project these capabilities into durable state, HTTP, SSE, or local UI.
 */
export interface AgentRunHost extends AgentChildAgentHost {
  readonly scope: AgentRunScope;

  emitEvent(event: AgentRuntimeEvent): void | Promise<void>;
  emitStreamEvent(event: StreamEvent): void | Promise<void>;
  requestPermission(input: AgentPermissionRequest): Promise<AgentPermissionDecision>;
}

export interface QueryEngine {
  submitMessage(
    content: string | ContentBlock[],
    options?: {
      signal?: AbortSignal;
      pullFollowUps?: () => string[] | Promise<string[]>;
      runtimeHost?: QueryRuntimeHost;
    },
  ): AsyncIterable<StreamEvent>;
  getHistory(): Message[];
  compact(): Promise<void>;
  clear(): void;
  setSystemPrompt(prompt: string): void;
  setApiClient(client: StreamingMessageClient): void;
  setModel(model: string): void;
  setMaxTurns(max: number): void;
  loadMessages(messages: Message[]): void;
  getTotalUsage(): import("./usage").UsageSnapshot;
  setMemoryRetriever(retriever: MemoryRetriever | undefined): void;
  setAttachmentsProvider(fn: CompactAttachmentsProvider | undefined): void;
  setAllowedTools(tools: string[] | null): void;
  setSessionId(sessionId: string | undefined): void;
  setMcpManager(mgr: unknown): void;
}

export interface MemoryRetriever {
  (userInput: string): Promise<string | null> | string | null;
}

export interface QueryEngineOptions {
  maxTurns?: number;
  /** Runtime working directory used for all tool execution in this engine. */
  cwd?: string;
  /** Runtime session id used to scope task/swarm ownership. */
  sessionId?: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  /** Default 300000 ms; can also be set with OPENHARNESS_TOOL_TIMEOUT_MS. */
  toolTimeoutMs?: number;
  settings?: Settings;
  compactKeepRecent?: number;
  skillRegistry?: unknown;
  memoryRetriever?: MemoryRetriever;
}

export type RuntimeSandboxState = "off" | "active" | "degraded" | "unavailable";

export interface RuntimeSandboxStatus {
  state: RuntimeSandboxState;
  enabled: boolean;
  active: boolean;
  backend?: string;
  platform?: string;
  reason?: string;
  degraded?: boolean;
  containerName?: string;
  containerCwd?: string;
  networkMode?: string;
  dns?: string[];
  proxy?: "configured" | "not configured";
  reuseContainer?: boolean;
}

export class RuntimeBundle {
  private cleanupCallbacks: Array<() => Promise<void> | void> = [];
  private syncCleanupCallbacks: Array<() => void> = [];
  sandboxStatus?: RuntimeSandboxStatus;

  constructor(
    public settings: Settings,
    public apiClient: StreamingMessageClient,
    public toolRegistry: ToolRegistry,
    public permissionChecker: PermissionChecker,
    public hookExecutor: HookExecutor,
    public queryEngine: QueryEngine,
  ) {}

  switchApiClient(newClient: StreamingMessageClient): void {
    this.apiClient = newClient;
    this.queryEngine.setApiClient(newClient);
  }

  addCleanup(cleanup: () => Promise<void> | void, cleanupSync?: () => void): void {
    this.cleanupCallbacks.push(cleanup);
    if (cleanupSync) this.syncCleanupCallbacks.push(cleanupSync);
  }

  async close(): Promise<void> {
    const callbacks = this.cleanupCallbacks.splice(0).reverse();
    this.syncCleanupCallbacks = [];
    for (const cleanup of callbacks) {
      await cleanup();
    }
  }

  closeSync(): void {
    const callbacks = this.syncCleanupCallbacks.splice(0).reverse();
    this.cleanupCallbacks = [];
    for (const cleanup of callbacks) {
      cleanup();
    }
  }
}
