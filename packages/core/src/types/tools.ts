import type { ContentBlock } from "./messages";

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  skillRegistry?: unknown;
  /** MCP 客户端管理器，供 McpToolCall / ListMcpResources / ReadMcpResource 元工具使用。 */
  mcpManager?: unknown;
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
