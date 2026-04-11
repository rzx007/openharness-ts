import type { ChannelAdapter, ChannelMessage } from "../index.js";

export class HttpAdapter implements ChannelAdapter {
  name = "http";
  private url?: string;
  private handler?: (message: ChannelMessage) => void;

  constructor(url?: string) {
    this.url = url;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async send(message: ChannelMessage): Promise<void> {
    if (!this.url) return;
    await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.handler = handler;
  }
}
