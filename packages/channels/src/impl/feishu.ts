import type { ChannelAdapter, ChannelMessage } from "../index";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  /**
   * @deprecated ACL 已上移 ChannelManager 集中处理（fail-closed：空 = 全拒）。
   * adapter 不再过滤；保留字段仅为旧调用方类型兼容。
   */
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

/** 消息去重窗口：60 秒内同一 message_id 只处理一次。 */
const DEDUP_TTL_MS = 60_000;

export class FeishuAdapter implements ChannelAdapter {
  name = "feishu";

  private client: LarkClient | null = null;
  private wsClient: LarkWSClient | null = null;
  private handler: ((message: ChannelMessage) => void) | undefined;
  private readonly replyAtBotNames: string[];
  /** 已处理的 message_id → 过期时刻，用于去重。 */
  private readonly seenMessageIds = new Map<string, number>();

  constructor(private readonly config: FeishuConfig) {
    // 统一转小写，使 @mention 匹配大小写不敏感。
    this.replyAtBotNames = (config.replyAtBotNames ?? []).map((n) => n.toLowerCase());
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
      "im.message.receive_v1": (data: unknown) => this._handleEvent(data),
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    }) as unknown as LarkWSClient;

    await this.wsClient.start({ eventDispatcher });
  }

  /** 处理 im.message.receive_v1 事件。提取为方法便于单元测试直接调用。 */
  async _handleEvent(data: unknown): Promise<void> {
    const msg = (data as { message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      content?: string;
      create_time?: string;
      sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
      mentions?: FeishuMention[];
    } })?.message;
    if (!msg?.chat_id) return;

    // bot 消息跳过：飞书在某些配置下会把 bot 自己发的消息也推回来，直接忽略。
    if (msg.sender?.sender_type === "bot") return;

    // 消息去重：60 s 内同一 message_id 只处理一次（防飞书重试重复投递）。
    const now = Date.now();
    if (msg.message_id) {
      const expiry = this.seenMessageIds.get(msg.message_id);
      if (expiry !== undefined && expiry > now) return;
      this.seenMessageIds.set(msg.message_id, now + DEDUP_TTL_MS);
      // 摊还清理过期条目，避免 Map 无限增长。
      if (this.seenMessageIds.size > 500) {
        for (const [id, exp] of this.seenMessageIds) {
          if (exp <= now) this.seenMessageIds.delete(id);
        }
      }
    }

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
        ? mentions.some((m) => m.name && this.replyAtBotNames.includes(m.name.toLowerCase()))
        : true;

    if (!isAtBot && isGroupChat) return;

    let contentText = text;
    for (const m of mentions) {
      if (m.key) contentText = contentText.replace(m.key, "").trim();
    }
    contentText = contentText.replace(/\s+/g, " ").trim();
    if (!contentText) return;

    const senderOpenId = msg.sender?.sender_id?.open_id;
    const senderId = senderOpenId ?? msg.sender?.sender_id?.user_id ?? msg.chat_id;

    // Reply target: group chats → chat_id，direct chats → sender open_id。
    const replyTo = isGroupChat ? msg.chat_id : (senderOpenId ?? msg.chat_id);

    const inbound: ChannelMessage = {
      id: `feishu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      channel: "feishu",
      sender: senderId,
      content: contentText,
      timestamp: new Date(Number(msg.create_time) || Date.now()),
      replyTo,
    };

    if (this.handler) this.handler(inbound);
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
