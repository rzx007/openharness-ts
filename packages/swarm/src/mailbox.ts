import { promises as fs, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { exclusiveFileLock } from "./lockfile.js";

/**
 * 文件式邮箱（移植自 Python swarm/mailbox.py）：leader/worker 跨进程通信的底座。
 *
 * 每条消息一个 JSON 文件：
 *   ~/.openharness/teams/<team>/agents/<agentId>/inbox/<timestamp>_<msgId>.json
 *
 * 原子写：先写 `.tmp` 再 rename，读者永远看不到半截消息；写/改/删都在
 * `.write_lock` 排他锁内进行（见 lockfile.ts）。
 */

export type MessageType =
  | "user_message"
  | "permission_request"
  | "permission_response"
  | "sandbox_permission_request"
  | "sandbox_permission_response"
  | "shutdown"
  | "idle_notification";

const MESSAGE_TYPES: ReadonlySet<string> = new Set<MessageType>([
  "user_message",
  "permission_request",
  "permission_response",
  "sandbox_permission_request",
  "sandbox_permission_response",
  "shutdown",
  "idle_notification",
]);

export interface MailboxMessage {
  id: string;
  type: MessageType;
  sender: string;
  recipient: string;
  payload: Record<string, unknown>;
  timestamp: number;
  read: boolean;
}

// ---------------------------------------------------------------------------
// 目录助手（对齐 Python get_team_dir / get_agent_mailbox_dir：调用即建目录）
// ---------------------------------------------------------------------------

const SAFE_PATH_COMPONENT = /^[A-Za-z0-9._@-]+$/;

/**
 * 校验拼进 teams 路径的名字（team/agentId 来自 LLM 工具入参与环境变量）。
 * 不安全的名字（路径分隔符、`..` 等）直接抛错——这些目录会在会话退出时被
 * 递归删除，穿越出 teams 根目录等于任意目录删除。Python 原版未接线所以没暴露
 * 这一面；TS 接线后必须收紧（sanitize_name 在 Python 中也是定义而未用）。
 */
function assertSafePathComponent(name: string, what: string): void {
  if (!SAFE_PATH_COMPONENT.test(name) || name === "." || name === "..") {
    throw new Error(`Unsafe ${what} for filesystem path: ${JSON.stringify(name)}`);
  }
}

export function getTeamDir(teamName: string): string {
  assertSafePathComponent(teamName, "team name");
  const dir = join(homedir(), ".openharness", "teams", teamName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAgentMailboxDir(teamName: string, agentId: string): string {
  assertSafePathComponent(agentId, "agent id");
  const dir = join(getTeamDir(teamName), "agents", agentId, "inbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// TeammateMailbox
// ---------------------------------------------------------------------------

function parseMessage(data: Record<string, unknown>): MailboxMessage | null {
  if (typeof data.id !== "string" || typeof data.timestamp !== "number") return null;
  if (typeof data.type !== "string" || !MESSAGE_TYPES.has(data.type)) return null;
  return {
    id: data.id,
    type: data.type as MessageType,
    sender: typeof data.sender === "string" ? data.sender : "",
    recipient: typeof data.recipient === "string" ? data.recipient : "",
    payload: (data.payload ?? {}) as Record<string, unknown>,
    timestamp: data.timestamp,
    read: data.read === true,
  };
}

export class TeammateMailbox {
  constructor(
    public readonly teamName: string,
    public readonly agentId: string,
  ) {}

  getMailboxDir(): string {
    return getAgentMailboxDir(this.teamName, this.agentId);
  }

  private lockPath(): string {
    return join(this.getMailboxDir(), ".write_lock");
  }

  /** 锁内 `.tmp` + rename 原子写；文件名 <timestamp>_<id>.json（6 位小数，字典序≈时间序）。 */
  async write(msg: MailboxMessage): Promise<void> {
    const inbox = this.getMailboxDir();
    const filename = `${msg.timestamp.toFixed(6)}_${msg.id}.json`;
    const finalPath = join(inbox, filename);
    const tmpPath = `${finalPath}.tmp`;
    const payload = JSON.stringify(msg, null, 2);

    await exclusiveFileLock(this.lockPath(), async () => {
      await fs.writeFile(tmpPath, payload, "utf-8");
      await fs.rename(tmpPath, finalPath);
    });
  }

  /** 按文件名（≈时间）排序返回；跳过点文件/.tmp/损坏 JSON。 */
  async readAll(unreadOnly = true): Promise<MailboxMessage[]> {
    const inbox = this.getMailboxDir();
    const entries = (await fs.readdir(inbox)).filter(
      (name) => name.endsWith(".json") && !name.startsWith(".") && !name.endsWith(".tmp"),
    );
    entries.sort();

    const messages: MailboxMessage[] = [];
    for (const name of entries) {
      let msg: MailboxMessage | null;
      try {
        msg = parseMessage(JSON.parse(await fs.readFile(join(inbox, name), "utf-8")));
      } catch {
        continue; // 损坏消息跳过而非崩溃
      }
      if (!msg) continue;
      if (!unreadOnly || !msg.read) messages.push(msg);
    }
    return messages;
  }

  /** 原位把消息标为已读（锁内 `.tmp` + rename）。 */
  async markRead(messageId: string): Promise<void> {
    const inbox = this.getMailboxDir();
    await exclusiveFileLock(this.lockPath(), async () => {
      const entries = (await fs.readdir(inbox)).filter(
        (name) => name.endsWith(".json") && !name.startsWith(".") && !name.endsWith(".tmp"),
      );
      for (const name of entries) {
        const path = join(inbox, name);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(await fs.readFile(path, "utf-8")) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (data.id === messageId) {
          data.read = true;
          const tmpPath = `${path}.tmp`;
          await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
          await fs.rename(tmpPath, path);
          return;
        }
      }
    });
  }

  /** 清空收件箱（保留目录与锁文件）。 */
  async clear(): Promise<void> {
    const inbox = this.getMailboxDir();
    await exclusiveFileLock(this.lockPath(), async () => {
      const entries = (await fs.readdir(inbox)).filter((name) => !name.startsWith("."));
      for (const name of entries) {
        await fs.unlink(join(inbox, name)).catch(() => {});
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

function makeMessage(
  type: MessageType,
  sender: string,
  recipient: string,
  payload: Record<string, unknown>,
): MailboxMessage {
  return {
    id: randomUUID(),
    type,
    sender,
    recipient,
    payload,
    timestamp: Date.now() / 1000,
    read: false,
  };
}

export function createUserMessage(sender: string, recipient: string, content: string): MailboxMessage {
  return makeMessage("user_message", sender, recipient, { content });
}

export function createShutdownRequest(sender: string, recipient: string): MailboxMessage {
  return makeMessage("shutdown", sender, recipient, {});
}

export function createIdleNotification(sender: string, recipient: string, summary: string): MailboxMessage {
  return makeMessage("idle_notification", sender, recipient, { summary });
}

/** worker→leader 的权限请求消息（payload 字段对齐 Python/TS teammateMailbox 形状）。 */
export function createPermissionRequestMessage(
  sender: string,
  recipient: string,
  requestData: Record<string, unknown>,
): MailboxMessage {
  return makeMessage("permission_request", sender, recipient, {
    type: "permission_request",
    request_id: requestData.request_id ?? "",
    agent_id: requestData.agent_id ?? sender,
    tool_name: requestData.tool_name ?? "",
    tool_use_id: requestData.tool_use_id ?? "",
    description: requestData.description ?? "",
    input: requestData.input ?? {},
    permission_suggestions: requestData.permission_suggestions ?? [],
  });
}

/** leader→worker 的权限响应消息；subtype=error 与 success 两种 payload 形状。 */
export function createPermissionResponseMessage(
  sender: string,
  recipient: string,
  responseData: Record<string, unknown>,
): MailboxMessage {
  const subtype = responseData.subtype ?? "success";
  if (subtype === "error") {
    return makeMessage("permission_response", sender, recipient, {
      type: "permission_response",
      request_id: responseData.request_id ?? "",
      subtype: "error",
      error: responseData.error ?? "Permission denied",
    });
  }
  return makeMessage("permission_response", sender, recipient, {
    type: "permission_response",
    request_id: responseData.request_id ?? "",
    subtype: "success",
    response: {
      updated_input: responseData.updated_input,
      permission_updates: responseData.permission_updates,
    },
  });
}

// ---------------------------------------------------------------------------
// 类型守卫（兼容 payload.text 内嵌 JSON 的信封格式）
// ---------------------------------------------------------------------------

function guard(msg: MailboxMessage, type: MessageType): Record<string, unknown> | null {
  if (msg.type === type) return msg.payload;
  const text = msg.payload.text;
  if (typeof text === "string" && text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).type === type) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 非 JSON 文本不是信封
    }
  }
  return null;
}

export function isPermissionRequest(msg: MailboxMessage): Record<string, unknown> | null {
  return guard(msg, "permission_request");
}

export function isPermissionResponse(msg: MailboxMessage): Record<string, unknown> | null {
  return guard(msg, "permission_response");
}

// ---------------------------------------------------------------------------
// 全局便捷函数
// ---------------------------------------------------------------------------

/**
 * 把 TeammateMessage 形状的 dict 写进收件人邮箱；从 text 嗅探消息类型以便路由。
 * team 缺省取 CLAUDE_CODE_TEAM_NAME，再缺省 "default"。
 */
export async function writeToMailbox(
  recipientName: string,
  message: Record<string, unknown>,
  teamName?: string,
): Promise<void> {
  const team = teamName ?? process.env.CLAUDE_CODE_TEAM_NAME ?? "default";
  const text = typeof message.text === "string" ? message.text : "";

  let msgType: MessageType = "user_message";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const t = (parsed as Record<string, unknown>).type;
      if (typeof t === "string" && MESSAGE_TYPES.has(t)) msgType = t as MessageType;
    }
  } catch {
    // 纯文本按 user_message 处理
  }

  const msg: MailboxMessage = {
    id: randomUUID(),
    type: msgType,
    sender: typeof message.from === "string" ? message.from : "unknown",
    recipient: recipientName,
    payload: {
      text,
      color: message.color,
      summary: message.summary,
      timestamp: message.timestamp,
    },
    timestamp: Date.now() / 1000,
    read: false,
  };
  await new TeammateMailbox(team, recipientName).write(msg);
}
