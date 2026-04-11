export type HookEvent =
  | "pre_tool_use"
  | "post_tool_use"
  | "session_start"
  | "session_end";

export type HookType = "command" | "http" | "prompt" | "agent";

interface HookDefinitionBase {
  id: string;
  event: HookEvent;
  enabled: boolean;
  timeout?: number;
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

export interface HookExecutor {
  register(hook: HookDefinition): void;
  execute(
    event: HookEvent,
    context: Record<string, unknown>
  ): Promise<void>;
}
