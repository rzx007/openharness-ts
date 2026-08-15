import type {
  PermissionMode,
  Settings,
  StreamingMessageClient,
} from "@openharness/core";
import type { AgentTerminalHost } from "@openharness/terminal";

/** Opinionated runtime configuration exposed by the programmatic agent API. */
export interface OpenHarnessAgentConfiguration {
  client?: StreamingMessageClient;
  apiKey?: string;
  apiFormat?: Settings["apiFormat"];
  baseUrl?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  /** Maximum tools granted by the SDK/host. Descendant agents inherit this ceiling. */
  hostToolCeiling?: string[];
  /** Tools this agent role wants to see. ["*"] means no extra role narrowing. */
  roleAllowedTools?: string[];
  /** Host tool ceiling kept under the existing public SDK option name. */
  allowedTools?: string[];
  disallowedTools?: string[];
  effort?: Settings["effort"];
  fastMode?: boolean;
  autoApproveReadOnly?: boolean;
  autoApproveTools?: string[];
  /** Host-owned persistent terminal capability. Descendant agents inherit it. */
  terminal?: AgentTerminalHost;
}
