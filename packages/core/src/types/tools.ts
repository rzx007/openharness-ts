import type { ContentBlock } from "./messages";
import type { Settings } from "./settings";
import type { AgentExecutionContext, AgentScheduleEffects } from "./runtime";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { AgentJobHost } from "@openharness/jobs";

export interface McpAuthConfigureInput {
  serverName: string;
  mode: "bearer" | "header" | "env";
  value: string;
  key?: string;
}

export interface McpAuthConfigureResult {
  message: string;
}

export interface McpAuthHost {
  configure(input: McpAuthConfigureInput): Promise<McpAuthConfigureResult>;
}

/** Host-owned creation boundary for detached shell jobs. */
export interface AgentBackgroundShellHost {
  create(input: {
    /** Stable identity for one logical creation request; retries must reuse it. */
    requestId: string;
    cwd: string;
    sessionId: string;
    command: string;
    description: string;
    settings?: Settings;
  }): Promise<{
    jobId: string;
    label: string;
  }>;
}

export type AgentImageToTextInput =
  | { attachmentId: string }
  | { imagePath: string }
  | { imageUrl: string };

export interface AgentImageToTextResult {
  status: "completed" | "no_text_detected";
  text: string;
  assetId: string;
  representationId: string;
  processor: "light-ocr";
  processorVersion: string;
  cached: boolean;
  lineCount: number;
  durationMs: number;
}

/** Host-owned local OCR boundary. The tool never calls a vision model itself. */
export interface AgentImageToTextHost {
  recognize(
    input: AgentImageToTextInput,
    context: { cwd: string; sessionId?: string; signal?: AbortSignal },
  ): Promise<AgentImageToTextResult>;
}

export interface AgentAttachmentTextSlice {
  displayName: string;
  mediaType: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  content: string;
  startLine: number;
  endLine: number;
  hasMore: boolean;
}

/** Host-owned access to immutable text attachments referenced by the current session. */
export interface AgentAttachmentResourceHost {
  readText(
    input: { assetId: string; offset: number; limit: number },
    context: { sessionId?: string; signal?: AbortSignal },
  ): Promise<AgentAttachmentTextSlice>;
}

export interface ToolContext {
  cwd: string;
  sessionId?: string;
  /** Stable model-issued tool call identity. Retries of the same call reuse this value. */
  toolCallId?: string;
  /** Identity of this concrete execution attempt. */
  toolAttemptId?: string;
  /** Lifetime of the owning session run; use for detached work that outlives this tool call. */
  runAbortSignal?: AbortSignal;
  /** Lifetime of this tool invocation, including its execution timeout. */
  abortSignal?: AbortSignal;
  settings?: Settings;
  /** Actual tools available to the current QueryEngine after host injection and allow/deny filtering. */
  toolRegistry?: ToolRegistry;
  skillRegistry?: unknown;
  /** MCP 客户端管理器，供 McpToolCall / ListMcpResources / ReadMcpResource 元工具使用。 */
  mcpManager?: unknown;
  /** Host-owned MCP auth updater. It saves config and reconnects the live MCP manager. */
  mcpAuth?: McpAuthHost;
  /** Host-owned persistent terminal capability. Omitted in runtimes without PTY support. */
  terminal?: AgentTerminalHost;
  /** Host-owned controller for all long-running work in the durable session. */
  jobs?: AgentJobHost;
  /** Host-owned creator for detached shell jobs. */
  backgroundShell?: AgentBackgroundShellHost;
  /** Host-owned local OCR capability. Omitted when OCR is unavailable. */
  imageToText?: AgentImageToTextHost;
  /** Session-authorized immutable text attachment access. */
  attachments?: AgentAttachmentResourceHost;
  /** Host-owned persistent scheduler. Omitted when durable schedules are unavailable. */
  schedules?: AgentScheduleEffects;
  agent?: AgentExecutionContext;
}

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  failureKind?: ToolFailureKind;
  metadata?: Record<string, unknown>;
}

export type ToolFailureKind =
  | "permission" | "policy" | "timeout" | "command" | "transport"
  | "provider" | "interrupted" | "unknown_outcome";

export interface ToolExecutionResult extends ToolResult {
  toolUseId: string;
  toolName: string;
  toolAttemptId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Automatic retry is forbidden unless this is explicitly true. */
  safeToRetry?: boolean;
  execute: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  unregister?(name: string): boolean;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  has(name: string): boolean;
}
