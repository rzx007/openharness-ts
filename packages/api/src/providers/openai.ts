import OpenAI from "openai";
import type {
  StreamingMessageClient,
  StreamMessageParams,
  StreamEvent,
  Message,
  ToolDefinition,
} from "@openharness/core";
import { retryWithBackoff } from "@openharness/core";
import type { ProviderConfig } from "./registry";

const MAX_RETRIES = 3;
const BASE_DELAY = 1000;
const MAX_DELAY = 30000;

export class OpenAICompatibleClient implements StreamingMessageClient {
  private _client: OpenAI;

  constructor(private config: ProviderConfig) {
    this._client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  get client(): OpenAI {
    return this._client;
  }

  set client(value: OpenAI) {
    this._client = value;
  }

  async *streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> {
    const messages = this.convertMessages(params);
    const tools = params.tools?.length ? params.tools.map(this.convertTool) : undefined;

    const createParams: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: params.model,
      messages,
      max_tokens: params.maxTokens ?? 8192,
      temperature: params.temperature,
      stream: true,
      stream_options: tools ? undefined : { include_usage: true },
      tools,
    };

    let collectedContent = "";
    const collectedToolCalls: Map<number, { id: string; name: string; arguments: string }> =
      new Map();
    let finishReason: string | null = null;
    let usageData = { inputTokens: 0, outputTokens: 0 };

    const stream = await this._client.chat.completions.create(createParams);

    for await (const chunk of stream) {
      if (!chunk.choices || chunk.choices.length === 0) {
        if (chunk.usage) {
          usageData = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
        continue;
      }

      const choice = chunk.choices[0]!;
      const delta = choice.delta;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      if (delta.content) {
        collectedContent += delta.content;
        yield { type: "text_delta", delta: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!collectedToolCalls.has(idx)) {
            collectedToolCalls.set(idx, { id: tc.id ?? "", name: "", arguments: "" });
          }
          const entry = collectedToolCalls.get(idx)!;
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }

      if (chunk.usage) {
        usageData = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    }

    for (const [, tc] of collectedToolCalls) {
      if (!tc.name) continue;
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.arguments || "{}");
      } catch {
        input = {};
      }
      yield {
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: tc.id, name: tc.name, input },
      };
    }

    yield {
      type: "usage",
      usage: {
        inputTokens: usageData.inputTokens,
        outputTokens: usageData.outputTokens,
      },
    };

    yield {
      type: "complete",
      stopReason: finishReason === "tool_calls" ? "tool_use" : finishReason ?? "end_turn",
    };
  }

  private convertMessages(params: StreamMessageParams): OpenAI.ChatCompletionMessageParam[] {
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
        case "assistant": {
          const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
            role: "assistant",
            content: typeof msg.content === "string" ? msg.content : null,
          };
          if (msg.toolUses?.length) {
            assistantMsg.tool_calls = msg.toolUses.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
              },
            }));
          }
          messages.push(assistantMsg);
          break;
        }
        case "tool_result":
          messages.push({
            role: "tool",
            tool_call_id: msg.toolUseId,
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          });
          break;
      }
    }

    return messages;
  }

  private convertTool(tool: ToolDefinition): OpenAI.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as OpenAI.FunctionParameters,
      },
    };
  }
}
