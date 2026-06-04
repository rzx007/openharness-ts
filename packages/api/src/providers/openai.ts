import OpenAI from "openai";
import type {
  StreamingMessageClient,
  StreamMessageParams,
  StreamEvent,
  ToolDefinition,
  ContentBlock,
} from "@openharness/core";
import type { ProviderConfig } from "./registry";
import { AuthenticationFailure, RateLimitFailure, RequestFailure } from "../errors/index";

const MAX_RETRIES = 3;
const BASE_DELAY = 1000;
const MAX_DELAY = 30_000;
const RETRYABLE_CODES = new Set([429, 500, 502, 503]);

// Model families that reject `max_tokens` and require `max_completion_tokens`.
const MAX_COMPLETION_TOKEN_MODEL_PREFIXES = ["gpt-5", "o1", "o3", "o4"];

// Env var opt-in for emitting an empty `reasoning_content` on tool-use
// assistant turns (Kimi-on-Anthropic style). Strict-OpenAI providers reject
// the field outright, so the default is off.
const EMPTY_REASONING_ENV = "OPENHARNESS_REQUIRE_EMPTY_REASONING_CONTENT";

// Matches complete <think>…</think> blocks (`s` flag so newlines are included).
const THINK_RE = /<think>.*?<\/think>/gs;
const THINK_OPEN_TAG = "<think>";

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

/**
 * Return the correct token-limit field for the target OpenAI model.
 *
 * GPT-5 and the current reasoning-model families (o1/o3/o4) reject
 * `max_tokens` and require `max_completion_tokens` instead.
 */
export function tokenLimitParamForModel(
  model: string,
  maxTokens: number,
): { max_tokens: number } | { max_completion_tokens: number } {
  let normalized = model.trim().toLowerCase();
  if (normalized.includes("/")) {
    normalized = normalized.slice(normalized.lastIndexOf("/") + 1);
  }
  if (MAX_COMPLETION_TOKEN_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return { max_completion_tokens: maxTokens };
  }
  return { max_tokens: maxTokens };
}

/**
 * Strip complete `<think>…</think>` blocks, returning `[visibleText, leftover]`.
 *
 * Complete pairs are removed via regex. An unclosed `<think>` is held back in
 * `leftover` so it can be re-evaluated once the closing tag arrives in the next
 * streaming chunk. Providers may also split the opening tag across chunk
 * boundaries (e.g. `"<thi"` then `"nk>"`), so the longest suffix that could
 * still become `<think>` is held back as well.
 */
export function stripThinkBlocks(buf: string): [string, string] {
  // Remove fully-closed blocks.
  const cleaned = buf.replace(THINK_RE, "");

  // Hold back any unclosed <think> for the next chunk.
  const openIdx = cleaned.indexOf(THINK_OPEN_TAG);
  if (openIdx !== -1) {
    return [cleaned.slice(0, openIdx), cleaned.slice(openIdx)];
  }

  // Hold back the longest suffix that could still become `<think>`.
  const maxPrefix = Math.min(cleaned.length, THINK_OPEN_TAG.length - 1);
  for (let prefixLen = maxPrefix; prefixLen > 0; prefixLen--) {
    if (THINK_OPEN_TAG.startsWith(cleaned.slice(cleaned.length - prefixLen))) {
      return [cleaned.slice(0, cleaned.length - prefixLen), cleaned.slice(cleaned.length - prefixLen)];
    }
  }

  return [cleaned, ""];
}

function emptyReasoningRequired(): boolean {
  const raw = (process.env[EMPTY_REASONING_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Convert user text/image content blocks into OpenAI chat content. Returns a
 * plain string when there are no images, otherwise the structured multimodal
 * array with `image_url` data-URI blocks.
 */
export function convertUserContentToOpenAI(
  blocks: ContentBlock[],
): string | OpenAI.ChatCompletionContentPart[] {
  const hasImage = blocks.some((b) => b.type === "image");
  if (!hasImage) {
    return blocks
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  const content: OpenAI.ChatCompletionContentPart[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${block.source.mediaType};base64,${block.source.data}`,
        },
      });
    }
  }
  return content;
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
      ...tokenLimitParamForModel(params.model, params.maxTokens ?? 8192),
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
    // Buffer to strip inline <think>…</think> blocks across streaming chunks.
    let thinkBuf = "";

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
            thinkBuf += delta.content;
            const [visible, leftover] = stripThinkBlocks(thinkBuf);
            thinkBuf = leftover;
            if (visible) {
              yield { type: "text_delta", delta: visible };
            }
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
        case "user": {
          if (typeof msg.content === "string") {
            messages.push({ role: "user", content: msg.content });
          } else {
            const content = convertUserContentToOpenAI(msg.content);
            if (typeof content === "string") {
              if (content.trim()) {
                messages.push({ role: "user", content });
              }
            } else if (content.length) {
              messages.push({ role: "user", content });
            }
          }
          break;
        }
        case "assistant": {
          const assistantMsg: ReasoningMessage = {
            role: "assistant",
            content: typeof msg.content === "string" ? msg.content : null,
          };
          const reasoning = this.reasoningHistory.get(turnIdx);
          if (reasoning) {
            assistantMsg.reasoning_content = reasoning;
          } else if (msg.toolUses?.length && emptyReasoningRequired()) {
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
