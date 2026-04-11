import type { ChannelAdapter, ChannelMessage } from "../index.js";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  allowFrom?: string[];
  replyAtBotNames?: string[];
}

interface LarkClient {
  im: {
    message: {
      create(params: {
        params: { receive_id_type: string };
        data: {
          receive_id: string;
          content: string;
          msg_type: string;
        };
      }): Promise<void>;
    };
  };
}

interface LarkWSClient {
  start(opts: { eventDispatcher: unknown }): Promise<void>;
  close(): Promise<void>;
}

interface FeishuMention {
  key?: string;
  name?: string;
}

export class FeishuAdapter implements ChannelAdapter {
  name = "feishu";

  private client: LarkClient | null = null;
  private wsClient: LarkWSClient | null = null;
  private handler: ((message: ChannelMessage) => void) | undefined;
  private readonly replyAtBotNames: string[];

  constructor(private readonly config: FeishuConfig) {
    this.replyAtBotNames = config.replyAtBotNames ?? [];
  }

  async connect(): Promise<void> {
    const lark = await import("@larksuiteoapi/node-sdk");

    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      disableTokenCache: false,
    }) as unknown as LarkClient;

    const eventDispatcher = new lark.EventDispatcher({
      encryptKey: this.config.encryptKey ?? "",
      verificationToken: this.config.verificationToken ?? "",
    }).register({
      "im.message.receive_v1": async (data: {
        message?: {
          chat_id?: string;
          chat_type?: string;
          content?: string;
          create_time?: string;
          sender?: { sender_id?: { user_id?: string } };
          mentions?: FeishuMention[];
        };
      }) => {
        const msg = data?.message;
        if (!msg?.chat_id) return;

        let text = "";
        try {
          const content = msg.content ? JSON.parse(msg.content) : {};
          text = content.text ?? "";
        } catch {
          text = String(msg.content ?? "");
        }
        if (!text) return;

        const isGroupChat = msg.chat_type === "group";
        const mentions = msg.mentions ?? [];
        const isAtBot =
          this.replyAtBotNames.length > 0
            ? mentions.some((m) =>
                m.name &&
                this.replyAtBotNames.includes(m.name.toLowerCase()),
              )
            : true;

        if (!isAtBot && isGroupChat) return;

        let contentText = text;
        for (const m of mentions) {
          if (m.key) contentText = contentText.replace(m.key, "").trim();
        }
        contentText = contentText.replace(/\s+/g, " ").trim();
        if (!contentText) return;

        const senderId =
          msg.sender?.sender_id?.user_id ?? msg.chat_id;
        const allowFrom = this.config.allowFrom ?? [];
        if (allowFrom.length > 0 && !allowFrom.includes(senderId)) return;

        const inbound: ChannelMessage = {
          id: `feishu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          channel: "feishu",
          sender: senderId,
          content: contentText,
          timestamp: new Date(Number(msg.create_time) || Date.now()),
        };

        if (this.handler) {
          this.handler(inbound);
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    }) as unknown as LarkWSClient;

    await this.wsClient.start({ eventDispatcher });
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      try {
        await this.wsClient.close();
      } catch {
        // ignore
      }
      this.wsClient = null;
    }
    this.client = null;
  }

  async send(message: ChannelMessage): Promise<void> {
    if (!this.client) {
      throw new Error("Feishu client not connected");
    }
    await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: message.id,
        content: JSON.stringify({ text: message.content }),
        msg_type: "text",
      },
    });
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.handler = handler;
  }
}
