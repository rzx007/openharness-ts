import Anthropic from "@anthropic-ai/sdk";
import type {
  StreamingMessageClient,
  StreamMessageParams,
  StreamEvent,
  Message,
  ToolDefinition,
} from "@openharness/core";
import type { ProviderConfig } from "./registry";

export class AnthropicClient implements StreamingMessageClient {
  private client: Anthropic;

  constructor(private config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  async *streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> {
    const messages = this.convertMessages(params.messages);
    const tools = params.tools?.map((t) => this.convertTool(t));

    const stream = this.client.messages.stream({
      model: params.model,
      messages,
      system: params.system,
      tools: tools?.length ? tools : undefined,
      max_tokens: params.maxTokens ?? 8192,
      temperature: params.temperature,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { type: "text_delta", delta: event.delta.text };
      } else if (
        event.type === "content_block_start" &&
        event.content_block.type === "tool_use"
      ) {
        yield {
          type: "tool_use_start",
          toolUse: {
            type: "tool_use",
            id: event.content_block.id,
            name: event.content_block.name,
            input: event.content_block.input as Record<string, unknown>,
          },
        };
      }
    }

    const final = await stream.finalMessage();
    yield {
      type: "usage",
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheCreationTokens: final.usage.cache_creation_input_tokens ?? undefined,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? undefined,
      },
    };
    yield { type: "complete", stopReason: final.stop_reason ?? "end_turn" };
  }

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages.map((msg) => {
      switch (msg.type) {
        case "user":
          return {
            role: "user" as const,
            content:
              typeof msg.content === "string"
                ? msg.content
                : (msg.content as Anthropic.TextBlockParam[]),
          };
        case "assistant":
          return {
            role: "assistant" as const,
            content: msg.content,
          };
        case "tool_result":
          return {
            role: "user" as const,
            content: [
              {
                type: "tool_result",
                tool_use_id: msg.toolUseId,
                content: msg.content,
                is_error: msg.isError,
              } as Anthropic.ToolResultBlockParam,
            ],
          };
        default:
          return {
            role: "user" as const,
            content: JSON.stringify(msg),
          };
      }
    });
  }

  private convertTool(tool: ToolDefinition): Anthropic.Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    };
  }
}
