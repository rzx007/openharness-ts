export interface ChannelMessage {
  id: string;
  channel: string;
  sender: string;
  content: string;
  timestamp: Date;
  /**
   * Conversation/reply target for outbound replies (e.g. a Feishu chat_id or
   * sender open_id). When unset, adapters fall back to `sender`.
   */
  replyTo?: string;
}

export interface ChannelAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: ChannelMessage): Promise<void>;
  onMessage(handler: (message: ChannelMessage) => void): void;
}

export { EventBus } from "./bus";
export { MessageBus } from "./bus/queue";
export type { InboundMessage, OutboundMessage } from "./bus/queue";
export { isAllowed } from "./bus/acl";
export { ChannelManager } from "./manager";
export type { ChannelManagerOptions, ChannelStatus } from "./manager";
export { ChannelBridge } from "./bridge";
export type { BridgeEngine } from "./bridge";
export { StdioAdapter } from "./impl/stdio";
export { HttpAdapter } from "./impl/http";
export { FeishuAdapter } from "./impl/feishu";
export type { FeishuConfig } from "./impl/feishu";
