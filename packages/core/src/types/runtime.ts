import type { StreamingMessageClient } from "./client";
import type { McpAuthHost, ToolRegistry } from "./tools";
import type { PermissionChecker } from "./permissions";
import type { HookExecutor } from "./hooks";
import type { ContentBlock, Message } from "./messages";
import type { StreamEvent } from "./events";
import type { Settings } from "./settings";
import type { CompactAttachmentsProvider } from "../engine/compact-service";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { AgentJobHost } from "@openharness/jobs";

export interface AgentPermissionRequest {
  toolName: string;
  reason?: string;
  input?: Record<string, unknown>;
}

export interface AgentPermissionDecision {
  status: "approved" | "denied" | "expired";
  decision?: "once" | "session";
  reason?: string;
}

export interface AgentCronJobInput {
  name: string;
  expression: string;
  command: string;
  cwd: string;
  timezone?: string;
  enabled?: boolean;
}

export interface AgentCronJob {
  name: string;
  expression: string;
  command: string;
  cwd: string;
  timezone?: string;
  enabled: boolean;
  nextRunAt?: number;
}

export interface AgentCronRun {
  status: "running" | "succeeded" | "failed" | "interrupted";
  output?: string;
  error?: string;
}

export interface AgentCronEffects {
  save(input: AgentCronJobInput): Promise<AgentCronJob>;
  remove(name: string): Promise<void>;
  list(): Promise<AgentCronJob[]>;
  setEnabled(name: string, enabled: boolean): Promise<AgentCronJob>;
  trigger(name: string): Promise<AgentCronRun>;
}

export interface AgentEffectContext {
  agentId: string;
  sessionId: string;
  runId: string;
  inputId: string;
  cwd: string;
  traceId: string;
  childId?: string;
  signal: AbortSignal;
}

export interface AgentEffects {
  requestPermission(
    input: AgentPermissionRequest,
    context: AgentEffectContext,
  ): Promise<AgentPermissionDecision>;
  cron?: AgentCronEffects;
}

export interface AgentChildSpawnInput {
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

export interface AgentChildInput {
  content: string;
  id?: string;
  delivery?: "queue" | "steer";
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentChildResult {
  status: "completed" | "failed" | "interrupted" | "stopped";
  output: string;
  error?: string;
}

export interface AgentInputReceipt {
  sessionId: string;
  inputId: string;
  runId: string;
}

export class AgentRunNotAcceptingInputError extends Error {
  constructor(readonly runId: string) {
    super(`Run is not accepting input: ${runId}`);
    this.name = "AgentRunNotAcceptingInputError";
  }
}

export interface AgentChildInvocation {
  id: string;
  sessionId: string;
  inputId?: string;
  runId?: string;
  result: Promise<AgentChildResult>;
  worktree?: { path: string; branch: string };
  notice?: string;
}

export interface AgentChildController {
  hasChildAgent(invocationId: string): boolean;
  spawnChildAgent(input: AgentChildSpawnInput): Promise<AgentChildInvocation>;
  sendChildInput(
    invocationId: string,
    input: AgentChildInput,
  ): Promise<AgentInputReceipt>;
  interruptChildAgent(invocationId: string, reason?: string): Promise<void>;
  awaitChildAgent(invocationId: string): Promise<AgentChildResult>;
}

export interface AgentRunScope {
  agentId: string;
  sessionId: string;
  runId: string;
  inputId: string;
  cwd: string;
  traceId: string;
  signal: AbortSignal;
}

export interface AgentEventContext {
  agentId: string;
  sessionId: string;
  inputId?: string;
  runId?: string;
  traceId?: string;
  childId?: string;
  parentSessionId?: string;
  parentRunId?: string;
}

export interface AgentSerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export type AgentEventInput =
  | {
      type: "input.accepted";
      data: {
        content: string | ContentBlock[];
        delivery: "queue" | "steer";
        metadata?: Record<string, unknown>;
      };
    }
  | { type: "run.started"; data: Record<string, never> }
  | { type: "run.completed"; data: { output: string; stopReason?: string } }
  | {
      type: "run.failed";
      data: { error: AgentSerializedError; output?: string };
    }
  | {
      type: "run.interrupted";
      data: { error: AgentSerializedError; output?: string };
    }
  | { type: "output.text.delta"; data: { delta: string } }
  | { type: "output.turn.completed"; data: { stopReason: string } }
  | {
      type: "tool.started";
      data: {
        toolUse: {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        };
      };
    }
  | {
      type: "tool.completed";
      data: {
        toolUseId: string;
        result: { content: ContentBlock[]; isError?: boolean };
      };
    }
  | { type: "usage.updated"; data: { usage: import("./usage").UsageSnapshot } }
  | {
      type: "domain.event";
      data: { name: string; payload?: Record<string, unknown> };
    }
  | {
      type: "permission.requested";
      data: { requestId: string; request: AgentPermissionRequest };
    }
  | {
      type: "permission.resolved";
      data: { requestId: string; decision: AgentPermissionDecision };
    }
  | {
      type: "child.created";
      data: {
        childId: string;
        sessionId: string;
        spawn: AgentChildSpawnInput;
        cwd: string;
        worktree?: { path: string; branch: string };
      };
    }
  | { type: "child.suspended"; data: { childId: string; sessionId: string } }
  | { type: "child.resumed"; data: { childId: string; sessionId: string } }
  | {
      type: "child.closed";
      data: { childId: string; sessionId: string; result: AgentChildResult };
    };

export type AgentEvent = AgentEventInput & {
  id: string;
  sequence: number;
  occurredAt: string;
  context: AgentEventContext;
};

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export type AgentEventSubscription = () => void;

export interface AgentEventSource {
  subscribe(listener: AgentEventListener): AgentEventSubscription;
}

/** Framework-internal execution capabilities shared with tool packages. */
export interface AgentExecutionContext {
  readonly scope: AgentRunScope;
  readonly effects: AgentEffects;
  readonly children: AgentChildController;
  emit(event: AgentEventInput): Promise<void>;
  takeSteeredInputs(options?: {
    closeIfEmpty?: boolean;
  }): Promise<AgentChildInput[]>;
  closeSteering(): void;
}

export interface AgentSteerInput extends AgentChildInput {}

export interface AgentRunResult {
  status: "completed";
  output: string;
  history: Message[];
  usage: import("./usage").UsageSnapshot;
}

export interface AgentRunHandle {
  readonly id: string;
  readonly inputId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly started: Promise<AgentInputReceipt>;
  readonly result: Promise<AgentRunResult>;
  steer(input: AgentSteerInput): Promise<AgentInputReceipt>;
  interrupt(reason?: string): Promise<void>;
}

export interface AgentChildHandle {
  readonly id: string;
  readonly sessionId: string;
  readonly state:
    "starting" | "running" | "idle" | "suspended" | "closing" | "closed";
  readonly result: Promise<AgentChildResult>;
  send(input: AgentChildInput): Promise<AgentInputReceipt>;
  interrupt(reason?: string): Promise<void>;
  close(): Promise<void>;
}

export interface AgentChildDirectory {
  get(childId: string): AgentChildHandle | undefined;
  getBySessionId(sessionId: string): AgentChildHandle | undefined;
  list(): AgentChildHandle[];
}

export interface QueryEngine {
  submitMessage(
    content: string | ContentBlock[],
    options?: {
      signal?: AbortSignal;
      execution?: AgentExecutionContext;
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
  setMcpAuth(auth: McpAuthHost | undefined): void;
  setTerminal(terminal: AgentTerminalHost | undefined): void;
  setJobs(jobs: AgentJobHost | undefined): void;
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

  addCleanup(
    cleanup: () => Promise<void> | void,
    cleanupSync?: () => void,
  ): void {
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
