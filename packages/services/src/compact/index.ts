import type { Message } from "@openharness/core";

export interface CompactOptions {
  maxMessages?: number;
  preserveSystem?: boolean;
}

export class CompactService {
  private options: CompactOptions;

  constructor(options: CompactOptions = {}) {
    this.options = options;
  }

  compact(messages: Message[]): Message[] {
    const max = this.options.maxMessages ?? 50;
    if (messages.length <= max) return messages;

    const start =
      this.options.preserveSystem !== false && messages[0]?.type === "system"
        ? 1
        : 0;

    const summary: Message = {
      type: "assistant",
      content: `[Conversation compacted: ${messages.length - start} messages summarized]`,
    };

    const kept = messages.slice(-Math.floor(max / 2));
    const result: Message[] = [];
    if (start === 1) result.push(messages[0]!);
    result.push(summary);
    result.push(...kept);
    return result;
  }
}
