import OpenAI from "openai";
import type { StreamingMessageClient, StreamMessageParams, StreamEvent } from "@openharness/core";
import { retryWithBackoff } from "@openharness/core";
import type { ProviderConfig } from "./registry";

export class OpenAICompatibleClient implements StreamingMessageClient {
  private client: OpenAI;

  constructor(private config: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  async *streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> {
    const messages = this.convertMessages(params);
    const tools = params.tools?.map(this.convertTool);

    const stream = await this.client.chat.completions.create({
      model: params.model,
      messages,
      tools: tools?.length ? tools : undefined,
      max_tokens: params.maxTokens ?? 8192,
      temperature: params.temperature,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: "text_delta", delta: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name) {
            yield {
              type: "tool_use_start",
              toolUse: {
                type: "tool_use",
                id: tc.id ?? "",
                name: tc.function.name,
                input: JSON.parse(tc.function.arguments ?? "{}"),
              },
            };
          }
        }
      }
    }

    yield { type: "complete", stopReason: "stop" };
  }

  private convertMessages(
    params: StreamMessageParams
  ): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }

    for (const msg of params.messages) {
      switch (msg.type) {
        case "user":
          messages.push({
            role: "user",
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          });
          break;
        case "assistant":
          messages.push({ role: "assistant", content: msg.content });
          break;
        case "tool_result":
          messages.push({
            role: "tool",
            tool_call_id: msg.toolUseId,
            content: JSON.stringify(msg.content),
          });
          break;
      }
    }

    return messages;
  }

  private convertTool(
    tool: import("@openharness/core").ToolDefinition
  ): OpenAI.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }
}
