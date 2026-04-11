import type { Message } from "@openharness/core";

export interface CompactOptions {
  maxMessages?: number;
  preserveSystem?: boolean;
  maxTokens?: number;
  keepRecent?: number;
  client?: { submitMessage: (content: string) => AsyncIterable<any> };
  model?: string;
}

const COMPACTABLE_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "ListMcpResources", "ReadMcpResource",
];

const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
const DEFAULT_KEEP_RECENT = 5;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const MAX_CONSECUTIVE_FAILURES = 3;

const BASE_COMPACT_PROMPT = `Summarize the following conversation between the user and an AI assistant.

Produce your summary in two sections:

<analysis>
- Briefly describe what the user was trying to accomplish
- What approach was taken
- Key findings and decisions made
- Any errors encountered and how they were resolved
</analysis>

<summary>
- Concise narrative of the conversation progress
- Key state: files modified, tools used, results obtained
- Any pending items or follow-up actions needed
</summary>

Keep the summary concise and focused on information needed for continuing the task.`;

export class CompactService {
  private maxTokens: number;
  private keepRecent: number;
  private client: CompactOptions["client"];
  private consecutiveFailures = 0;

  constructor(
    maxTokens: number = DEFAULT_CONTEXT_WINDOW,
    keepRecent: number = DEFAULT_KEEP_RECENT,
    options: Omit<CompactOptions, "maxTokens" | "keepRecent"> = {},
  ) {
    this.maxTokens = maxTokens;
    this.keepRecent = keepRecent;
    this.client = options.client;
  }

  async autoCompact(messages: Message[]): Promise<Message[]> {
    const estimatedTokens = estimateTokenCount(messages);
    const threshold =
      this.maxTokens - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS;

    if (estimatedTokens < threshold) return messages;

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return this.microCompact(messages);
    }

    if (this.client) {
      try {
        const result = await this.llmCompact(messages);
        this.consecutiveFailures = 0;
        return result;
      } catch {
        this.consecutiveFailures++;
      }
    }

    return this.microCompact(messages);
  }

  compact(messages: Message[]): Message[] {
    const max = this.keepRecent * 2;
    if (messages.length <= max) return messages;

    const start =
      messages[0]?.type === "system" ? 1 : 0;

    const summary: Message = {
      type: "assistant",
      content: `[Conversation compacted: ${messages.length - start} messages summarized]`,
    };

    const kept = messages.slice(-this.keepRecent);
    const result: Message[] = [];
    if (start === 1) result.push(messages[0]!);
    result.push(summary);
    result.push(...kept);
    return result;
  }

  microCompact(messages: Message[]): Message[] {
    if (messages.length <= this.keepRecent) return messages;

    const result: Message[] = [];
    const recentStart = Math.max(0, messages.length - this.keepRecent);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (i >= recentStart) {
        result.push(msg);
        continue;
      }
      if ((msg as any).type === "tool_result" || (msg as any).type === "tool_use") {
        const toolName = (msg as any).toolName ?? (msg as any).name ?? "";
        if (COMPACTABLE_TOOLS.some((t) => toolName.includes(t) || t.includes(toolName))) {
          result.push({
            ...msg,
            content: [{ type: "text" as const, text: "[Old tool result content cleared]" }],
          } as Message);
          continue;
        }
      }
      result.push(msg);
    }

    return result;
  }

  private async llmCompact(messages: Message[]): Promise<Message[]> {
    if (!this.client) throw new Error("No LLM client available");

    const recentStart = Math.max(0, messages.length - this.keepRecent);
    const olderMessages = messages.slice(0, recentStart);
    if (!olderMessages.length) return messages;

    const conversationText = olderMessages
      .map((m) => {
        const role = m.type === "user" ? "User" : m.type === "assistant" ? "Assistant" : "System";
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${role}: ${content.slice(0, 2000)}`;
      })
      .join("\n\n");

    const prompt = `${BASE_COMPACT_PROMPT}\n\n<conversation>\n${conversationText}\n</conversation>`;

    let summaryText = "";
    for await (const event of this.client.submitMessage(prompt)) {
      if (event.type === "text_delta") {
        summaryText += event.delta;
      }
    }

    const summary: Message = {
      type: "assistant",
      content: summaryText || "[Conversation compacted via LLM summary]",
    };

    const recent = messages.slice(recentStart);
    const result: Message[] = [];
    if (messages[0]?.type === "system") {
      result.push(messages[0]!);
      if (recentStart === 0) {
        result.push(summary);
      } else {
        result.push(summary);
        result.push(...recent.filter((m) => m.type !== "system"));
      }
    } else {
      result.push(summary);
      result.push(...recent);
    }

    return result;
  }
}

function estimateTokenCount(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    total += Math.ceil(content.length / 4);
  }
  return total;
}
