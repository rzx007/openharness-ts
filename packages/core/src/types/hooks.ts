export type HookEvent =
  | "session_start"
  | "session_end"
  | "pre_compact"
  | "post_compact"
  | "pre_tool_use"
  | "post_tool_use"
  | "user_prompt_submit"
  | "notification"
  | "stop"
  | "subagent_stop";

/** All hook events, aligned with Python `HookEvent` enum. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "session_start",
  "session_end",
  "pre_compact",
  "post_compact",
  "pre_tool_use",
  "post_tool_use",
  "user_prompt_submit",
  "notification",
  "stop",
  "subagent_stop",
];

export type HookType = "command" | "http" | "prompt" | "agent";

interface HookDefinitionBase {
  id: string;
  event: HookEvent;
  enabled: boolean;
  timeout?: number;
  /** fnmatch/glob-style matcher against the event subject (tool name / prompt / event). */
  matcher?: string;
  /** Higher priority runs first within an event; ties keep registration order. */
  priority?: number;
  /** Whether a failed/rejecting hook blocks continuation. */
  blockOnFailure?: boolean;
}

export interface CommandHookDefinition extends HookDefinitionBase {
  type: "command";
  command: string;
}

export interface HttpHookDefinition extends HookDefinitionBase {
  type: "http";
  url: string;
  method?: string;
}

export interface PromptHookDefinition extends HookDefinitionBase {
  type: "prompt";
  prompt: string;
  model?: string;
}

export interface AgentHookDefinition extends HookDefinitionBase {
  type: "agent";
  prompt: string;
  model?: string;
}

export type HookDefinition =
  | CommandHookDefinition
  | HttpHookDefinition
  | PromptHookDefinition
  | AgentHookDefinition;

export interface HookResult {
  blocked: boolean;
  reason?: string;
}

export interface HookExecutor {
  register(hook: HookDefinition): void;
  execute(
    event: HookEvent,
    context: Record<string, unknown>
  ): Promise<HookResult>;
}
