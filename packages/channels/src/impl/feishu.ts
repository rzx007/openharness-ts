import type { ChannelAdapter, ChannelMessage } from "../index";

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
          sender?: { sender_id?: { open_id?: string; user_id?: string } };
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

        const senderOpenId = msg.sender?.sender_id?.open_id;
        const senderId =
          senderOpenId ?? msg.sender?.sender_id?.user_id ?? msg.chat_id;
        const allowFrom = this.config.allowFrom ?? [];
        if (allowFrom.length > 0 && !allowFrom.includes(senderId)) return;

        // Reply target mirrors the Python channel: group chats reply back to
        // the chat (chat_id), direct chats reply to the sender (open_id).
        const replyTo = isGroupChat
          ? msg.chat_id
          : (senderOpenId ?? msg.chat_id);

        const inbound: ChannelMessage = {
          id: `feishu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          channel: "feishu",
          sender: senderId,
          content: contentText,
          timestamp: new Date(Number(msg.create_time) || Date.now()),
          replyTo,
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
    // The reply target is the inbound conversation, not the synthetic message
    // id. Prefer `replyTo` (chat_id for groups, sender open_id for direct
    // chats); fall back to `sender` for adapters that don't set `replyTo`.
    const receiveId = message.replyTo ?? message.sender;
    // Mirror the Python channel's heuristic: chat ids start with "oc_" and use
    // the "chat_id" id-type; everything else is an open_id.
    const receiveIdType = receiveId.startsWith("oc_") ? "chat_id" : "open_id";
    await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ text: message.content }),
        msg_type: "text",
      },
    });
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.handler = handler;
  }
}
