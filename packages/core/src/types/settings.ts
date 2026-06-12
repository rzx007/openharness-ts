import type { PermissionMode } from "./permissions";
import type { HookDefinition } from "./hooks";

export interface McpServerConfig {
  /** Explicit transport type. When omitted it is inferred from url/command. */
  type?: "stdio" | "http" | "sse";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http / sse
  url?: string;
  headers?: Record<string, string>;
}

export interface MemoryConfig {
  enabled: boolean;
  maxFiles?: number;
  maxEntrypointLines?: number;
  /** autodream（记忆梦境整合）开关与触发门槛（E.6）。 */
  autoDreamEnabled?: boolean;
  autoDreamMinHours?: number;
  autoDreamMinSessions?: number;
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
  autoApproveTools?: string[];
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
  /** 是否加载项目目录（<cwd>/.openharness/plugins）的插件。缺省 false：信任门控。 */
  allowProjectPlugins?: boolean;
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
