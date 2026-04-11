import type { Message } from "../index";

export class CompactService {
  private maxTokens: number;
  private keepRecent: number;

  constructor(maxTokens = 100_000, keepRecent = 10) {
    this.maxTokens = maxTokens;
    this.keepRecent = keepRecent;
  }

  async autoCompact(messages: Message[]): Promise<Message[]> {
    const estimated = this.estimateTokens(messages);
    if (estimated < this.maxTokens) return messages;

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
    for (const msg of messages) {
      if (msg.type === "tool_result") {
        const truncated: Message = {
          ...msg,
          content: [{ type: "text", text: "[tool result compacted]" }],
        };
        result.push(truncated);
      } else {
        result.push(msg);
      }
    }
    return result;
  }

  estimateTokens(messages: Message[]): number {
    return messages.reduce((total, msg) => {
      const content =
        typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return total + Math.ceil(content.length / 4);
    }, 0);
  }
}
