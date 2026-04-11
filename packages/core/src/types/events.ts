import type { ContentBlock } from "./messages";
import type { UsageSnapshot } from "./usage";

export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
}

export interface ToolUseStartEvent {
  type: "tool_use_start";
  toolUse: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
}

export interface ToolUseEndEvent {
  type: "tool_use_end";
  toolUseId: string;
  result: {
    content: ContentBlock[];
    isError?: boolean;
  };
}

export interface ErrorEvent {
  type: "error";
  error: Error;
}

export interface UsageEvent {
  type: "usage";
  usage: UsageSnapshot;
}

export interface CompleteEvent {
  type: "complete";
  stopReason: string;
}

export type StreamEvent =
  | TextDeltaEvent
  | ToolUseStartEvent
  | ToolUseEndEvent
  | ErrorEvent
  | UsageEvent
  | CompleteEvent;
