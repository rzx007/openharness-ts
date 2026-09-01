import type {
  AgentChildBudget,
  AgentBackgroundShellHost,
  AgentImageToTextHost,
  AgentAttachmentResourceHost,
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

/**
 * 迁移期间供尚未迁移的内部调用方使用；阶段一任务 3 迁移所有消费者后删除。
 * 新的 DefaultNodeAgent 装配 API 请使用 AgentEffectOverrides。
 * @deprecated Migration-only legacy type; remove in phase 1 task 3.
 */
export interface AgentPermissionHost {
  requestPermission: AgentEffects["requestPermission"];
}

/**
 * 迁移期间供尚未迁移的内部调用方使用；阶段一任务 3 迁移所有消费者后删除。
 * 新的 DefaultNodeAgent 装配 API 请使用 AgentCapabilityOverrides。
 * @deprecated Migration-only legacy type; remove in phase 1 task 3.
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
  /** Stable per-session directory exposed read-only inside Docker. */
  attachmentResourceRoot?: string;
}

export type CapabilityOverride<T> = T | false;

export interface ObservableJobProducer<T> {
  value: T;
  jobs: AgentJobHost;
}

export interface AgentCapabilityOverrides {
  terminal?: CapabilityOverride<ObservableJobProducer<AgentTerminalHost>>;
  backgroundShell?: CapabilityOverride<
    ObservableJobProducer<AgentBackgroundShellHost>
  >;
  jobs?: false;
  attachments?: CapabilityOverride<AgentAttachmentResourceHost>;
  memory?: false;
  childEnvironment?: CapabilityOverride<AgentChildEnvironmentProvider>;
  workflowRepository?: CapabilityOverride<WorkflowRunRepository>;
  imageToText?: CapabilityOverride<AgentImageToTextHost>;
  schedules?: CapabilityOverride<AgentScheduleEffects>;
}

export interface AgentEffectOverrides {
  requestPermission?: AgentEffects["requestPermission"];
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
