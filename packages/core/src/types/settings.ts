import type { PermissionMode } from "./permissions";
import type { HookDefinition } from "./hooks";

export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: never;
  headers?: never;
}

export interface McpRemoteServerConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  command?: never;
  args?: never;
  env?: never;
  cwd?: never;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface MemoryConfig {
  enabled: boolean;
  maxFiles?: number;
  maxEntrypointLines?: number;
  /** Keep a deterministic per-session checkpoint for compact continuity. */
  sessionMemoryEnabled?: boolean;
  /** Run a best-effort memory extraction pass after completed user turns. */
  autoExtractEnabled?: boolean;
  /** autodream（记忆梦境整合）开关与触发门槛（E.6）。 */
  autoDreamEnabled?: boolean;
  autoDreamMinHours?: number;
  autoDreamMinSessions?: number;
}

export interface SandboxConfig {
  enabled: boolean;
  backend?: "srt" | "docker";
  failIfUnavailable?: boolean;
  enabledPlatforms?: Array<"linux" | "wsl" | "macos">;
  filesystem?: SandboxFilesystemConfig;
  network?: SandboxNetworkConfig;
  docker?: DockerSandboxConfig;
  srt?: SrtSandboxConfig;
}

export interface SandboxFilesystemConfig {
  allowRead?: string[];
  denyRead?: string[];
  allowWrite?: string[];
  denyWrite?: string[];
  extraAllowedRoots?: string[];
}

export interface SandboxNetworkConfig {
  mode?: "none" | "bridge" | "host" | "proxy";
  allowedDomains?: string[];
  deniedDomains?: string[];
  strictDomainPolicy?: boolean;
}

export interface DockerSandboxConfig {
  image?: string;
  autoBuildImage?: boolean;
  cpuLimit?: number;
  memoryLimit?: string;
  dns?: string[];
  extraMounts?: string[];
  extraEnv?: Record<string, string>;
  containerNamePrefix?: string;
  reuseContainer?: boolean;
}

export interface SrtSandboxConfig {
  runtimeCommand?: string;
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

export interface FeishuChannelSettings {
  enabled: boolean;
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  /** ACL 白名单：name→chat_id 映射，空 = 全拒（fail-closed），{ "*": "*" } = 全放。 */
  allowFrom: Record<string, string>;
  /** 群聊中只响应 @ 这些名字的消息；空 = 群聊全响应。 */
  replyAtBotNames?: string[];
}

/** 通道配置（D.2）。结构对齐 Python ChannelConfigs，仅含已实现的通道。 */
export interface ChannelsConfig {
  /** 转发进度类出站消息（默认 true）。 */
  sendProgress?: boolean;
  /** 转发工具提示类出站消息（默认 true）。 */
  sendToolHints?: boolean;
  feishu?: FeishuChannelSettings;
}

export interface DaemonConfig {
  /** Start the local daemon after sign-in and restore it after unexpected exits. */
  autoStart: boolean;
}

export interface CustomProviderModelSettings {
  id: string;
  displayName: string;
}

export interface CustomProviderSettings {
  id: string;
  displayName: string;
  baseUrl: string;
  apiFormat: "openai";
  models: CustomProviderModelSettings[];
  headers?: Record<string, string>;
  source?: "models.dev";
}

export interface Settings {
  apiKey?: string;
  model: string;
  apiFormat: "anthropic" | "openai";
  maxTokens?: number;
  baseUrl?: string;
  provider?: string;
  customProviders?: CustomProviderSettings[];
  maxTurns: number;
  systemPrompt?: string;
  permission: PermissionSettings;
  hooks?: HookDefinition[];
  memory?: MemoryConfig;
  sandbox?: SandboxConfig;
  mcpServers?: Record<string, McpServerConfig>;
  channels?: ChannelsConfig;
  daemon?: DaemonConfig;
  theme?: string;
  outputStyle?: string;
  fastMode?: boolean;
  effort?: "low" | "medium" | "high";
  passes?: number;
  /** Root-tree child-agent limits. Omitted fields use runtime defaults. */
  childBudget?: Partial<import("./runtime").AgentChildBudget>;
  verbose?: boolean;
  /** 视觉模型（image_to_text fallback 用）。缺省用主模型（需支持视觉）。 */
  visionModel?: string;
  /** 图像生成端点基础 URL（缺省复用 baseUrl）。 */
  imageGenerationBaseUrl?: string;
}
