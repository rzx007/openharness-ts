import type { StreamingMessageClient, StreamMessageParams, StreamEvent } from "@openharness/core";
import type { ProviderConfig } from "./registry";

export class CopilotClient implements StreamingMessageClient {
  constructor(private config: ProviderConfig) {}

  async *streamMessage(_params: StreamMessageParams): AsyncIterable<StreamEvent> {
    throw new Error("CopilotClient not yet implemented");
  }
}
