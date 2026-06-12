import type { ChannelAdapter, ChannelMessage } from "./index.js";
import { MessageBus, type InboundMessage } from "./bus/queue.js";
import { isAllowed } from "./bus/acl.js";

/**
 * 通道管理器（移植自 Python channels/impl/manager.py）。
 *
 * 与 Python 差异：
 * - Python 在内部按 config 硬编码 import 11 个通道；TS 改为外部注入
 *   adapter 实例（组装在 CLI 侧），manager 只管启停与路由。
 * - ACL 集中在这里而非 BaseChannel——adapter 保持薄，统一 fail-closed。
 * - 出站循环用 AbortSignal 退出而非 wait_for 1s 轮询。
 */

export interface ChannelManagerOptions {
  /** 按通道名的 ACL 白名单（缺失/空 = 全拒）。 */
  allowFrom: Record<string, string[]>;
  /** 是否转发 _progress 出站消息（默认 true，对齐 Python send_progress）。 */
  sendProgress?: boolean;
  /** 是否转发 _tool_hint 出站消息（默认 true，对齐 Python send_tool_hints）。 */
  sendToolHints?: boolean;
  onWarning?: (message: string) => void;
}

export interface ChannelStatus {
  running: boolean;
  lastError?: string;
}

export class ChannelManager {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly status = new Map<string, ChannelStatus>();
  private dispatchAbort: AbortController | null = null;
  private dispatchDone: Promise<void> | null = null;

  constructor(
    adapters: ChannelAdapter[],
    private readonly bus: MessageBus,
    private readonly opts: ChannelManagerOptions,
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.name, adapter);
      this.status.set(adapter.name, { running: false });
    }
  }

  async startAll(): Promise<void> {
    for (const [name, allowList] of Object.entries(this.opts.allowFrom)) {
      if (allowList.length === 0) {
        this.opts.onWarning?.(
          `通道 ${name} 的 allowFrom 为空——远程访问全部拒绝。显式加入允许的身份或用 ["*"]。`,
        );
      }
    }
    for (const name of this.adapters.keys()) {
      if (!(name in this.opts.allowFrom)) {
        this.opts.onWarning?.(
          `通道 ${name} 未配置 allowFrom——远程访问全部拒绝。显式加入允许的身份或用 ["*"]。`,
        );
      }
    }

    this.dispatchAbort = new AbortController();
    this.dispatchDone = this.dispatchOutbound(this.dispatchAbort.signal);

    for (const [name, adapter] of this.adapters) {
      adapter.onMessage((msg) => this.handleInbound(name, msg));
      try {
        await adapter.connect();
        this.status.set(name, { running: true });
      } catch (err) {
        // 单通道启动失败不拖垮整体（对齐 Python _start_channel）。
        this.status.set(name, {
          running: false,
          lastError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async stopAll(): Promise<void> {
    this.dispatchAbort?.abort();
    await this.dispatchDone?.catch(() => {});
    this.dispatchAbort = null;
    this.dispatchDone = null;

    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.disconnect();
      } catch {
        // 停止失败只影响该通道
      }
      this.status.set(name, { ...this.status.get(name)!, running: false });
    }
  }

  getStatus(): Record<string, ChannelStatus> {
    return Object.fromEntries(this.status);
  }

  get enabledChannels(): string[] {
    return [...this.adapters.keys()];
  }

  private handleInbound(channelName: string, msg: ChannelMessage): void {
    const allowList = this.opts.allowFrom[channelName];
    if (!isAllowed(msg.sender, allowList)) {
      this.opts.onWarning?.(
        `通道 ${channelName} 拒绝来自 ${msg.sender} 的消息（不在 allowFrom）。`,
      );
      return;
    }
    const inbound: InboundMessage = {
      channel: channelName,
      senderId: msg.sender,
      // replyTo 是 adapter 解析出的会话目标（群 chat_id / 私聊 open_id），
      // 作为 chatId 既是回复地址也是 session key 的一半。
      chatId: msg.replyTo ?? msg.sender,
      content: msg.content,
      timestamp: msg.timestamp,
      media: [],
      metadata: { _message_id: msg.id },
    };
    this.bus.publishInbound(inbound);
  }

  private async dispatchOutbound(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let msg;
      try {
        msg = await this.bus.consumeOutbound(signal);
      } catch {
        break; // aborted
      }

      const meta = msg.metadata ?? {};
      if (meta["_progress"]) {
        const isToolHint = Boolean(meta["_tool_hint"]);
        if (isToolHint && this.opts.sendToolHints === false) continue;
        if (!isToolHint && this.opts.sendProgress === false) continue;
      }

      const adapter = this.adapters.get(msg.channel);
      if (!adapter) {
        this.opts.onWarning?.(`未知通道:${msg.channel}（出站消息丢弃）`);
        continue;
      }
      try {
        await adapter.send({
          id: `out_${Date.now()}`,
          channel: msg.channel,
          sender: msg.chatId,
          content: msg.content,
          timestamp: new Date(),
          replyTo: msg.chatId,
        });
      } catch (err) {
        // 发送失败记日志不中断循环（对齐 Python）。
        this.opts.onWarning?.(
          `通道 ${msg.channel} 发送失败:${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
