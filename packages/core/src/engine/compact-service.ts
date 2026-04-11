import type { Message } from "../index";

export class CompactService {
  private maxTokens: number;

  constructor(maxTokens = 100_000) {
    this.maxTokens = maxTokens;
  }

  async autoCompact(messages: Message[]): Promise<Message[]> {
    const estimated = this.estimateTokens(messages);
    if (estimated < this.maxTokens) return messages;

    // TODO: implement LLM-based summarization
    const systemMessages = messages.filter((m) => m.type === "system");
    const recentMessages = messages.slice(-10);

    return [...systemMessages, ...recentMessages];
  }

  private estimateTokens(messages: Message[]): number {
    return messages.reduce((total, msg) => {
      const content =
        typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return total + Math.ceil(content.length / 4);
    }, 0);
  }
}
