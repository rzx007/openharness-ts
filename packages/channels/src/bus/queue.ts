/**
 * 消息总线（移植自 Python channels/bus/{events,queue}.py）。
 *
 * inbound/outbound 双异步队列，解耦通道与引擎：通道收到消息推 inbound，
 * 桥接层处理后推 outbound，由 ChannelManager 分发回通道。
 *
 * 与 Python 差异：asyncio.Queue → 自实现 promise 队列（消费者先到挂起
 * resolver，生产者先到缓冲）；退出用 AbortSignal 而非 wait_for 1s 轮询。
 */

export interface InboundMessage {
  channel: string;
  senderId: string;
  chatId: string;
  content: string;
  timestamp: Date;
  /** 媒体 URL 列表（基础版仅透传，下载留待）。 */
  media: string[];
  /** 通道私有数据。 */
  metadata: Record<string, unknown>;
  /** 会话键覆盖（如线程级会话）。 */
  sessionKeyOverride?: string;
}

export interface OutboundMessage {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string;
  media?: string[];
  metadata?: Record<string, unknown>;
}

/** 单向异步 FIFO 队列：缓冲与挂起消费者二者最多只有一边非空。 */
class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<{ resolve: (v: T) => void; reject: (e: Error) => void }> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
    } else {
      this.buffer.push(item);
    }
  }

  pull(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new Error("consume aborted"));
    }
    const head = this.buffer.shift();
    if (head !== undefined) {
      return Promise.resolve(head);
    }
    return new Promise<T>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            reject(new Error("consume aborted"));
          }
        },
        { once: true },
      );
    });
  }

  get size(): number {
    return this.buffer.length;
  }
}

export class MessageBus {
  private readonly inbound = new AsyncQueue<InboundMessage>();
  private readonly outbound = new AsyncQueue<OutboundMessage>();

  publishInbound(msg: InboundMessage): void {
    this.inbound.push(msg);
  }

  consumeInbound(signal?: AbortSignal): Promise<InboundMessage> {
    return this.inbound.pull(signal);
  }

  publishOutbound(msg: OutboundMessage): void {
    this.outbound.push(msg);
  }

  consumeOutbound(signal?: AbortSignal): Promise<OutboundMessage> {
    return this.outbound.pull(signal);
  }

  get inboundSize(): number {
    return this.inbound.size;
  }

  get outboundSize(): number {
    return this.outbound.size;
  }

  /** 会话键：override 优先，否则 `channel:chatId`（对齐 Python session_key）。 */
  static sessionKey(msg: InboundMessage): string {
    return msg.sessionKeyOverride ?? `${msg.channel}:${msg.chatId}`;
  }
}
