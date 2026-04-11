import type { ChannelAdapter, ChannelMessage } from "../index";

export class SlackAdapter implements ChannelAdapter {
  name = "slack";

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(_message: ChannelMessage): Promise<void> {}
  onMessage(_handler: (message: ChannelMessage) => void): void {}
}
