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
  ToolDefinition,
} from "@openharness/core";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { AgentJobHost } from "@openharness/jobs";
import type { WorkflowRunRepository } from "@openharness/coordinator";
import type { AgentChildEnvironmentProvider } from "./child-environment.js";

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
  /** New tools. Creation fails if any name already exists. */
  tools?: ToolDefinition[];
  /** Complete replacements for existing built-in tools. */
  toolOverrides?: ToolDefinition[];
  /** First-party replacements that retain the replaced built-in permission classification. */
  trustedToolOverrides?: string[];
  /** Overrides the root-tree child-agent limits. */
  childBudget?: Partial<AgentChildBudget>;
}
