import type {
  PermissionMode,
  Settings,
  StreamingMessageClient,
} from "@openharness/core";

/** Opinionated runtime configuration exposed by the programmatic agent API. */
export interface OpenHarnessAgentConfiguration {
  client?: StreamingMessageClient;
  apiKey?: string;
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
}
