import type { PermissionMode } from "./permissions";
import type { HookDefinition } from "./hooks";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MemoryConfig {
  enabled: boolean;
  maxEntries?: number;
}

export interface SandboxConfig {
  enabled: boolean;
  runtime?: string;
}

export interface Settings {
  apiKey?: string;
  model: string;
  apiFormat: "anthropic" | "openai" | "copilot";
  permissionMode: PermissionMode;
  maxTurns: number;
  theme?: string;
  outputStyle?: string;
  plugins?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: HookDefinition[];
  memory?: MemoryConfig;
  sandbox?: SandboxConfig;
}
