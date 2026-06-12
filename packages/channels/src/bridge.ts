import { MessageBus, type InboundMessage } from "./bus/queue.js";

/**
 * 通道桥接（移植自 Python channels/adapter.py ChannelBridge）。
 *
 * 持续消费 inbound → 喂给引擎 `submitMessage()` 聚合 text_delta →
 * 把回复作为 outbound 发布回 bus（由 ChannelManager 分发）。
 * 顺序处理（一次一条），并发会话隔离留待。
 */

/** 桥接需要的最小引擎面（与 @openharness/core QueryEngine 结构兼容）。 */
export interface BridgeEngine {
  submitMessage(content: string): AsyncIterable<{ type: string; delta?: string }>;
}

export class ChannelBridge {
  private abort: AbortController | null = null;
  private done: Promise<void> | null = null;

  constructor(private readonly deps: { engine: BridgeEngine; bus: MessageBus }) {}

  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    this.done = this.loop(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.done?.catch(() => {});
    this.abort = null;
    this.done = null;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let msg: InboundMessage;
      try {
        msg = await this.deps.bus.consumeInbound(signal);
      } catch {
        break; // aborted
      }
      await this.handle(msg);
    }
  }

  private async handle(msg: InboundMessage): Promise<void> {
    const parts: string[] = [];
    try {
      for await (const event of this.deps.engine.submitMessage(msg.content)) {
        if (event.type === "text_delta" && event.delta) {
          parts.push(event.delta);
        }
      }
    } catch {
      // 对齐 Python 的兜底文案——通道侧用户必须收到失败信号。
      parts.length = 0;
      parts.push("[Error: failed to process your message]");
    }

    const reply = parts.join("").trim();
    if (!reply) return;

    this.deps.bus.publishOutbound({
      channel: msg.channel,
      chatId: msg.chatId,
      content: reply,
      metadata: { _session_key: MessageBus.sessionKey(msg) },
    });
  }
}
