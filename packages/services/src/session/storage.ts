import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { getSessionsDir, sanitizeMessageHistory } from "@openharness/core";

/**
 * 会话快照持久化（移植自 Python services/session_storage.py）。
 *
 * 相比旧平铺方案的增强：
 * - 按项目分目录：`<sessionsDir>/<项目名>-<sha1(cwd)前12>/`（与 session-memory 同式）；
 * - `latest.json` + `session-<id>.json` 双写（`--continue` 不再靠文件名猜最新）；
 * - tool_metadata 白名单持久化 + 深度 sanitize；
 * - summary（首条 user 消息前 80 字符）与 message_count；
 * - transcript.md Markdown 导出。
 *
 * 与 Python 差异：消息形状宽松（不做 pydantic 校验）；配对修复只做 load 侧
 * （Python save/load 双侧）——保存原样落盘，读回时剔除尾部悬挂 tool_use 与
 * 孤儿 tool_result，防止 resume 出 API 必拒的断链历史。
 */

const PERSISTED_TOOL_METADATA_KEYS = [
  "permission_mode",
  "read_file_state",
  "invoked_skills",
  "async_agent_state",
  "async_agent_tasks",
  "recent_work_log",
  "recent_verified_work",
  "task_focus_state",
  "compact_checkpoints",
  "compact_last",
] as const;

/** 宽松消息形状（兼容引擎 Message 联合：type 即角色，SystemMessage 无 role）。 */
export interface StoredMessageLike {
  type?: string;
  role?: string;
  content: string | ReadonlyArray<unknown>;
}

export interface SessionSnapshotPayload {
  schema_version: 1;
  session_id: string;
  cwd: string;
  model: string;
  system_prompt: string;
  messages: unknown[];
  usage: Record<string, unknown>;
  tool_metadata: Record<string, unknown>;
  created_at: number;
  summary: string;
  message_count: number;
  /** coordinator / worker / undefined（普通会话）。 */
  session_mode?: string;
}

export interface SessionListItem {
  session_id: string;
  summary: string;
  message_count: number;
  model: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// 路径与序列化助手
// ---------------------------------------------------------------------------

export function getProjectSessionDir(cwd: string): string {
  const root = resolve(cwd);
  const digest = createHash("sha1").update(root).digest("hex").slice(0, 12);
  const dir = join(getSessionsDir(), `${basename(root)}-${digest}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeMetadata(value: unknown): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (value instanceof Set || Array.isArray(value)) {
    return [...(value as Iterable<unknown>)].map(sanitizeMetadata);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeMetadata(v)]),
    );
  }
  return String(value);
}

function persistableToolMetadata(toolMetadata?: Record<string, unknown>): Record<string, unknown> {
  if (!toolMetadata) return {};
  const payload: Record<string, unknown> = {};
  for (const key of PERSISTED_TOOL_METADATA_KEYS) {
    if (key in toolMetadata) payload[key] = sanitizeMetadata(toolMetadata[key]);
  }
  return payload;
}

function messageRole(message: StoredMessageLike): string {
  return message.role ?? message.type ?? "system";
}

function messageText(message: StoredMessageLike): string {
  if (typeof message.content === "string") return message.content;
  let text = "";
  for (const block of message.content) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (typeof b?.text === "string") text += (text ? " " : "") + b.text;
  }
  return text;
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
}

function extractSummary(messages: StoredMessageLike[]): string {
  for (const message of messages) {
    if (messageRole(message) !== "user") continue;
    const text = messageText(message).trim();
    if (text) return text.slice(0, 80);
  }
  return "";
}

// ---------------------------------------------------------------------------
// 保存 / 读取 / 列表
// ---------------------------------------------------------------------------

export interface SaveSessionOptions {
  cwd: string;
  model: string;
  systemPrompt: string;
  messages: StoredMessageLike[];
  usage: Record<string, unknown>;
  sessionId?: string;
  toolMetadata?: Record<string, unknown>;
  /** 会话模式：coordinator / worker，普通会话不传。 */
  sessionMode?: string;
}

/** 保存快照：latest.json + session-<id>.json 双写，返回 latest 路径。 */
export function saveSessionSnapshot(options: SaveSessionOptions): string {
  const sessionDir = getProjectSessionDir(options.cwd);
  const sid = options.sessionId ?? randomBytes(6).toString("hex");
  const messages = sanitizeStoredMessages(options.messages as unknown[]) as StoredMessageLike[];

  const payload: SessionSnapshotPayload = {
    schema_version: 1,
    session_id: sid,
    cwd: resolve(options.cwd),
    model: options.model,
    system_prompt: options.systemPrompt,
    messages: messages as unknown[],
    usage: options.usage,
    tool_metadata: persistableToolMetadata(options.toolMetadata),
    created_at: Date.now() / 1000,
    summary: extractSummary(messages),
    message_count: messages.length,
    ...(options.sessionMode ? { session_mode: options.sessionMode } : {}),
  };
  const data = JSON.stringify(payload, null, 2) + "\n";

  const latestPath = join(sessionDir, "latest.json");
  atomicWrite(latestPath, data);
  atomicWrite(join(sessionDir, `session-${sid}.json`), data);
  return latestPath;
}


/**
 * 存储层复用 core 的消息历史不变量，读写两侧保持同一套 tool_use/tool_result 配对规则：
 * - 尾部悬挂 tool_use（崩溃/MaxTurns 中断落盘）→ 截掉，否则下一轮 API 必 400；
 * - 孤儿 tool_result（前一条没有 tool_use）→ 丢弃。
 */
export function sanitizeStoredMessages(messages: unknown[]): unknown[] {
  return sanitizeMessageHistory(messages);
}

function sanitizePayload(payload: SessionSnapshotPayload): SessionSnapshotPayload {
  if (payload.schema_version !== 1) {
    throw new Error(`Unsupported session snapshot schema version: ${String(payload.schema_version)}`);
  }
  if (!payload.session_id || !Array.isArray(payload.messages)) {
    throw new Error("Invalid session snapshot: session_id and messages are required");
  }
  const messages = sanitizeStoredMessages(payload.messages);
  return { ...payload, messages, message_count: messages.length };
}

function readPayload(path: string): SessionSnapshotPayload {
  return JSON.parse(readFileSync(path, "utf-8")) as SessionSnapshotPayload;
}

/** 读项目最近一次会话（latest.json）。 */
export function loadSessionSnapshot(cwd: string): SessionSnapshotPayload | null {
  const path = join(getProjectSessionDir(cwd), "latest.json");
  if (!existsSync(path)) return null;
  return sanitizePayload(readPayload(path));
}

/** 列出项目会话（新→旧，latest 去重补位）。 */
export function listSessionSnapshots(cwd: string, limit = 20): SessionListItem[] {
  const sessionDir = getProjectSessionDir(cwd);
  const sessions: SessionListItem[] = [];
  const seenIds = new Set<string>();

  const named = readdirSync(sessionDir)
    .filter((name) => name.startsWith("session-") && name.endsWith(".json"))
    .map((name) => join(sessionDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  const toItem = (data: SessionSnapshotPayload): SessionListItem => ({
    session_id: data.session_id,
    summary: data.summary,
    message_count: data.message_count,
    model: data.model,
    created_at: data.created_at,
  });

  for (const path of named) {
    const item = toItem(sanitizePayload(readPayload(path)));
    seenIds.add(item.session_id);
    sessions.push(item);
    if (sessions.length >= limit) break;
  }

  const latestPath = join(sessionDir, "latest.json");
  if (existsSync(latestPath) && sessions.length < limit) {
    const data = sanitizePayload(readPayload(latestPath));
    if (!seenIds.has(data.session_id)) {
      const item = toItem(data);
      sessions.push(item);
    }
  }

  sessions.sort((a, b) => b.created_at - a.created_at);
  return sessions.slice(0, limit);
}

/** 按 ID 删除会话：named 文件 + latest（若 id 匹配）一并删除，返回是否找到。 */
export function deleteSessionById(cwd: string, sessionId: string): boolean {
  if (/[/\\]/.test(sessionId) || sessionId.includes("..")) return false;
  const sessionDir = getProjectSessionDir(cwd);
  const { unlinkSync } = require("node:fs") as typeof import("node:fs");
  let deleted = false;
  const namedPath = join(sessionDir, `session-${sessionId}.json`);
  if (existsSync(namedPath)) {
    try { unlinkSync(namedPath); deleted = true; } catch { /* ignore */ }
  }
  const latestPath = join(sessionDir, "latest.json");
  if (existsSync(latestPath)) {
    const data = sanitizePayload(readPayload(latestPath));
    if (data.session_id === sessionId) {
      try { unlinkSync(latestPath); } catch { /* ignore */ }
    }
  }
  return deleted;
}

/** 按 ID 读会话：named 优先，latest 兜底（id 匹配或 "latest"）。 */
export function loadSessionById(cwd: string, sessionId: string): SessionSnapshotPayload | null {
  // id 进文件名：拒绝路径分隔符/..（--resume 入参不可穿越会话目录）。
  if (/[\/]/.test(sessionId) || sessionId.includes("..")) return null;
  const sessionDir = getProjectSessionDir(cwd);
  const namedPath = join(sessionDir, `session-${sessionId}.json`);
  if (existsSync(namedPath)) return sanitizePayload(readPayload(namedPath));

  const latestPath = join(sessionDir, "latest.json");
  if (existsSync(latestPath)) {
    const data = readPayload(latestPath);
    if (data.session_id === sessionId || sessionId === "latest") return sanitizePayload(data);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Markdown 导出
// ---------------------------------------------------------------------------

/** 导出 transcript.md：角色分节 + ```tool / ```tool-result 围栏。 */
export function exportSessionMarkdown(options: { cwd: string; messages: StoredMessageLike[] }): string {
  const path = join(getProjectSessionDir(options.cwd), "transcript.md");
  const parts: string[] = ["# OpenHarness Session Transcript"];

  for (const message of options.messages) {
    const role = messageRole(message);
    parts.push(`\n## ${role.charAt(0).toUpperCase()}${role.slice(1)}\n`);
    const text = messageText(message).trim();
    if (text) parts.push(text);

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const b = block as { type?: unknown; name?: unknown; input?: unknown; content?: unknown } | null;
        if (b?.type === "tool_use" && typeof b.name === "string") {
          parts.push(`\n\`\`\`tool\n${b.name} ${JSON.stringify(b.input ?? {})}\n\`\`\``);
        }
        if (b?.type === "tool_result") {
          const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
          parts.push(`\n\`\`\`tool-result\n${content}\n\`\`\``);
        }
      }
    }
  }

  atomicWrite(path, parts.join("\n").trim() + "\n");
  return path;
}
