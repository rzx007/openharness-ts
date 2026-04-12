import OpenAI from "openai";
import type {
  StreamingMessageClient,
  StreamMessageParams,
  StreamEvent,
  ToolDefinition,
} from "@openharness/core";
import type { ProviderConfig } from "./registry";
import { AuthenticationFailure, RateLimitFailure, RequestFailure } from "../errors/index.js";

const MAX_RETRIES = 3;
const BASE_DELAY = 1000;
const MAX_DELAY = 30_000;
const RETRYABLE_CODES = new Set([429, 500, 502, 503]);

interface ReasoningMessage {
  content?: string | null;
  role: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export class OpenAICompatibleClient implements StreamingMessageClient {
  private _client: OpenAI;
  private reasoningHistory: Map<number, string> = new Map();

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
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      max_tokens: params.maxTokens ?? 8192,
      temperature: params.temperature,
      stream: true,
      stream_options: tools ? undefined : { include_usage: true },
      tools,
    };

    const collectedToolCalls: Map<number, { id: string; name: string; arguments: string }> =
      new Map();
    let finishReason: string | null = null;
    let usageData = { inputTokens: 0, outputTokens: 0 };
    let collectedReasoning = "";

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
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
            yield { type: "text_delta", delta: delta.content };
          }

          const reasoningPiece = (delta as any).reasoning_content;
          if (reasoningPiece) {
            collectedReasoning += reasoningPiece;
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

        break;
      } catch (error) {
        lastError = this.classifyError(error);
        const status = (error as any)?.status ?? (error as any)?.statusCode;
        if (attempt < MAX_RETRIES && status && RETRYABLE_CODES.has(status)) {
          const retryAfter = this.getRetryAfter(error);
          const jitter = Math.random() * 1000;
          const delay = retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_DELAY)
            : Math.min(BASE_DELAY * 2 ** attempt + jitter, MAX_DELAY);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw lastError;
      }
    }

    const turnKey = this.reasoningHistory.size;
    if (collectedReasoning) {
      this.reasoningHistory.set(turnKey, collectedReasoning);
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

  private getRetryAfter(error: any): number {
    const header = error?.headers?.get?.("retry-after") ?? error?.headers?.["retry-after"];
    if (header) {
      const secs = Number(header);
      if (!isNaN(secs)) return secs;
    }
    return 0;
  }

  private classifyError(error: any): Error {
    const status = error?.status ?? error?.statusCode;
    const message = error?.message ?? String(error);

    if (status === 401 || status === 403) {
      return new AuthenticationFailure(message);
    }
    if (status === 429) {
      return new RateLimitFailure(message);
    }
    if (status) {
      return new RequestFailure(message, status);
    }
    return error instanceof Error ? error : new Error(message);
  }

  private convertMessages(params: StreamMessageParams): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }

    let turnIdx = 0;
    for (const msg of params.messages) {
      switch (msg.type) {
        case "user":
          messages.push({
            role: "user",
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          });
          break;
        case "assistant": {
          const assistantMsg: ReasoningMessage = {
            role: "assistant",
            content: typeof msg.content === "string" ? msg.content : null,
          };
          const reasoning = this.reasoningHistory.get(turnIdx);
          if (reasoning) {
            assistantMsg.reasoning_content = reasoning;
          } else if (msg.toolUses?.length) {
            assistantMsg.reasoning_content = "";
          }
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
          messages.push(assistantMsg as unknown as OpenAI.ChatCompletionMessageParam);
          turnIdx++;
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
