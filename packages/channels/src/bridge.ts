import { MessageBus, type InboundMessage } from "./bus/queue.js";

/**
 * 通道桥接（移植自 Python channels/adapter.py ChannelBridge）。
 *
 * 持续消费 inbound → 交给 agent `submitMessage()` →
 * 把回复作为 outbound 发布回 bus（由 ChannelManager 分发）。
 * 顺序处理（一次一条），并发会话隔离留待。
 */

/** 桥接只依赖 programmatic agent facade，不接触 QueryEngine。 */
export interface BridgeAgent {
  submitMessage(content: string): {
    result: Promise<{ output: string }>;
    interrupt(reason?: string): Promise<void>;
  };
}

export class EphemeralChannelBridge {
  private abort: AbortController | null = null;
  private done: Promise<void> | null = null;
  private activeRun: ReturnType<BridgeAgent["submitMessage"]> | null = null;

  constructor(
    private readonly deps: {
      agent: BridgeAgent;
      bus: MessageBus;
      /** 运维侧日志钩子（引擎错误等）；通道用户只看到兜底文案。 */
      onWarning?: (message: string) => void;
    },
  ) {}

  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    this.done = this.loop(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    let failure: unknown;
    let failed = false;
    try {
      await this.activeRun?.interrupt("Channel bridge stopped");
    } catch (error) {
      failure = error;
      failed = true;
    }
    try {
      await this.done?.catch(() => {});
    } finally {
      this.abort = null;
      this.done = null;
      this.activeRun = null;
    }
    if (failed) throw failure;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let msg: InboundMessage;
      try {
        msg = await this.deps.bus.consumeInbound(signal);
      } catch {
        break; // aborted
      }
      try {
        await this.handle(msg);
      } catch (err) {
        // 对齐 Python _loop 的兜底 except:单条失败不杀整个循环。
        this.deps.onWarning?.(
          `bridge 处理消息失败:${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async handle(msg: InboundMessage): Promise<void> {
    let reply = "";
    try {
      const run = this.deps.agent.submitMessage(msg.content);
      this.activeRun = run;
      reply = (await run.result).output.trim();
    } catch (err) {
      // 对齐 Python 的兜底文案——通道侧用户必须收到失败信号。
      this.deps.onWarning?.(
        `引擎处理失败(${msg.channel}/${msg.chatId}):${err instanceof Error ? err.message : String(err)}`,
      );
      reply = "[Error: failed to process your message]";
    } finally {
      this.activeRun = null;
    }

    if (!reply) return;

    this.deps.bus.publishOutbound({
      channel: msg.channel,
      chatId: msg.chatId,
      content: reply,
      metadata: { _session_key: MessageBus.sessionKey(msg) },
    });
  }
}

/** @deprecated 正式 serve 使用 DurableChannelBridge；这里只保留临时库测试兼容。 */
export const ChannelBridge = EphemeralChannelBridge;
