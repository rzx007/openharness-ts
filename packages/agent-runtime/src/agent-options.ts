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
  allowedTools?: string[];
  disallowedTools?: string[];
  effort?: Settings["effort"];
  fastMode?: boolean;
  autoApproveReadOnly?: boolean;
  autoApproveTools?: string[];
}
