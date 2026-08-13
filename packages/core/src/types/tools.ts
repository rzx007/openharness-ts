import type { ContentBlock } from "./messages";
import type { Settings } from "./settings";
import type { AgentExecutionContext } from "./runtime";

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

export interface ToolContext {
  cwd: string;
  sessionId?: string;
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
  agent?: AgentExecutionContext;
}

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

export interface ToolExecutionResult extends ToolResult {
  toolUseId: string;
  toolName: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    input: Record<string, unknown>,
    context: ToolContext
  ) => Promise<ToolResult>;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  has(name: string): boolean;
}
