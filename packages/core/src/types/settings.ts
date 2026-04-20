import type { PermissionMode } from "./permissions";
import type { HookDefinition } from "./hooks";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MemoryConfig {
  enabled: boolean;
  maxFiles?: number;
  maxEntrypointLines?: number;
}

export interface SandboxConfig {
  enabled: boolean;
  runtime?: string;
  failIfUnavailable?: boolean;
}

export interface PathRuleConfig {
  pattern: string;
  allow: boolean;
}

export interface PermissionSettings {
  mode: PermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
  pathRules?: PathRuleConfig[];
  deniedCommands?: string[];
}

export interface Settings {
  apiKey?: string;
  model: string;
  apiFormat: "anthropic" | "openai";
  maxTokens?: number;
  baseUrl?: string;
  provider?: string;
  maxTurns: number;
  systemPrompt?: string;
  permission: PermissionSettings;
  hooks?: HookDefinition[];
  memory?: MemoryConfig;
  sandbox?: SandboxConfig;
  plugins?: Record<string, boolean>;
  mcpServers?: Record<string, McpServerConfig>;
  theme?: string;
  outputStyle?: string;
  vimMode?: boolean;
  voiceMode?: boolean;
  fastMode?: boolean;
  effort?: "low" | "medium" | "high";
  passes?: number;
  verbose?: boolean;
}
