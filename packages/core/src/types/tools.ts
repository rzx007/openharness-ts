import type { ContentBlock } from "./messages";

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  skillRegistry?: unknown;
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
