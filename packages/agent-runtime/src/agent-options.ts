import type {
  AgentChildBudget,
  AgentBackgroundShellHost,
  AgentImageToTextHost,
  AgentAttachmentResourceHost,
  AgentContextMemoryHost,
  AgentEffects,
  AgentScheduleEffects,
  PermissionMode,
  Settings,
  StreamingMessageClient,
} from "@openharness/core";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { AgentJobHost } from "@openharness/jobs";
import type { WorkflowRunRepository } from "@openharness/coordinator";
import type { AgentChildEnvironmentProvider } from "./child-environment.js";

/** 宿主怎样处理权限请求。Kernel 不自己决定允许或拒绝。 */
export interface AgentPermissionHost {
  requestPermission: AgentEffects["requestPermission"];
}

/**
 * 宿主明确交给 Agent 的能力。没提供的能力不会由 Kernel 自己去本机寻找。
 */
export interface AgentHostCapabilities {
  permissions: AgentPermissionHost;
  jobs?: AgentJobHost;
  backgroundShell?: AgentBackgroundShellHost;
  terminal?: AgentTerminalHost;
  schedules?: AgentScheduleEffects;
  childEnvironment?: AgentChildEnvironmentProvider;
  workflowRepository?: WorkflowRunRepository;
  imageToText?: AgentImageToTextHost;
  attachments?: AgentAttachmentResourceHost;
  contextMemory?: AgentContextMemoryHost;
  /** Stable per-session directory exposed read-only inside Docker. */
  attachmentResourceRoot?: string;
}

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
  disallowedTools?: string[];
  effort?: Settings["effort"];
  fastMode?: boolean;
  /** Per-agent override for the installed Native Plugin master switch. */
  pluginsEnabled?: boolean;
  autoApproveReadOnly?: boolean;
  autoApproveTools?: string[];
  /** Overrides the root-tree child-agent limits. */
  childBudget?: Partial<AgentChildBudget>;
}
