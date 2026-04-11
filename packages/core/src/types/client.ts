import type { Message } from "./messages";
import type { StreamEvent } from "./events";
import type { ToolDefinition } from "./tools";

export interface StreamMessageParams {
  model: string;
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export interface StreamingMessageClient {
  streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent>;
}
