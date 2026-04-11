import type { Message, StreamEvent } from "../index";

const COMPACTABLE_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch",
];

const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
const MAX_CONSECUTIVE_FAILURES = 3;

const COMPACT_PROMPT = `Summarize the following conversation between the user and an AI assistant.

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
  private client: CompactClient | undefined;
  private consecutiveFailures = 0;

  constructor(
    maxTokens = 100_000,
    keepRecent = 10,
    client?: CompactClient,
  ) {
    this.maxTokens = maxTokens;
    this.keepRecent = keepRecent;
    this.client = client;
  }

  async autoCompact(messages: Message[]): Promise<Message[]> {
    const estimated = this.estimateTokens(messages);
    const threshold =
      this.maxTokens - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS;

    if (estimated < threshold) return messages;

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

    return this.simpleCompact(messages);
  }

  simpleCompact(messages: Message[]): Message[] {
    const systemMessages = messages.filter((m) => m.type === "system");
    const nonSystem = messages.filter((m) => m.type !== "system");

    const compactable = nonSystem.slice(0, -this.keepRecent);
    const recent = nonSystem.slice(-this.keepRecent);

    if (compactable.length === 0) return messages;

    const compactedCount = compactable.length;
    const toolResultCount = compactable.filter((m) => m.type === "tool_result").length;

    const summary: Message = {
      type: "assistant",
      content: `[Conversation compacted: ${compactedCount} messages summarized (${toolResultCount} tool results removed). ${recent.length} recent messages preserved.]`,
    };

    return [...systemMessages, summary, ...recent];
  }

  microCompact(messages: Message[]): Message[] {
    const result: Message[] = [];
    const recentStart = Math.max(0, messages.length - this.keepRecent);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (i >= recentStart) {
        result.push(msg);
        continue;
      }
      if (msg.type === "tool_result") {
        result.push({
          ...msg,
          content: [{ type: "text" as const, text: "[tool result compacted]" }],
        });
        continue;
      }
      result.push(msg);
    }
    return result;
  }

  private async llmCompact(messages: Message[]): Promise<Message[]> {
    if (!this.client) throw new Error("No LLM client");

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

    const prompt = `${COMPACT_PROMPT}\n\n<conversation>\n${conversationText}\n</conversation>`;

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
    const systemMessages = messages.filter((m) => m.type === "system");
    const nonSystemRecent = recent.filter((m) => m.type !== "system");

    return [...systemMessages, summary, ...nonSystemRecent];
  }

  estimateTokens(messages: Message[]): number {
    return messages.reduce((total, msg) => {
      const content =
        typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return total + Math.ceil(content.length / 4);
    }, 0);
  }
}

export interface CompactClient {
  submitMessage(content: string): AsyncIterable<StreamEvent>;
}
