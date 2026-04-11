export interface SystemMessage {
  type: "system";
  content: string;
}

export interface UserMessage {
  type: "user";
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  type: "assistant";
  content: string;
  toolUses?: ToolUseBlock[];
}

export interface ToolResultMessage {
  type: "tool_result";
  toolUseId: string;
  content: ContentBlock[];
  isError?: boolean;
}

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    mediaType: string;
    data: string;
  };
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ImageBlock;
