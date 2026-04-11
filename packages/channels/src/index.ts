export interface ChannelMessage {
  id: string;
  channel: string;
  sender: string;
  content: string;
  timestamp: Date;
}

export interface ChannelAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: ChannelMessage): Promise<void>;
  onMessage(handler: (message: ChannelMessage) => void): void;
}

export { EventBus } from "./bus";
