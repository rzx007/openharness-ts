import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { getSessionsDir } from "@openharness/core";

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

  const payload: SessionSnapshotPayload = {
    session_id: sid,
    cwd: resolve(options.cwd),
    model: options.model,
    system_prompt: options.systemPrompt,
    messages: options.messages as unknown[],
    usage: options.usage,
    tool_metadata: persistableToolMetadata(options.toolMetadata),
    created_at: Date.now() / 1000,
    summary: extractSummary(options.messages),
    message_count: options.messages.length,
    ...(options.sessionMode ? { session_mode: options.sessionMode } : {}),
  };
  const data = JSON.stringify(payload, null, 2) + "\n";

  const latestPath = join(sessionDir, "latest.json");
  atomicWrite(latestPath, data);
  atomicWrite(join(sessionDir, `session-${sid}.json`), data);
  return latestPath;
}


/** 块级探测：消息是否含 tool_use / 是否为 tool_result 消息。
 *  兼容两种格式：
 *  - 引擎内部格式：{type:"assistant", toolUses:[...]}
 *  - Anthropic 内容块格式：{content:[{type:"tool_use",...}]}
 */
function hasToolUseBlock(message: StoredMessageLike): boolean {
  const m = message as unknown as Record<string, unknown>;
  if (Array.isArray(m.toolUses) && (m.toolUses as unknown[]).length > 0) {
    return true;
  }
  return Array.isArray(message.content) &&
    message.content.some((b) => (b as { type?: unknown } | null)?.type === "tool_use");
}

function isToolResultMessage(message: StoredMessageLike): boolean {
  if (message.type === "tool_result" || message.role === "tool_result") return true;
  return Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((b) => (b as { type?: unknown } | null)?.type === "tool_result");
}

/**
 * load 侧配对修复（对齐 Python _sanitize_snapshot_payload 的意图）：
 * - 尾部悬挂 tool_use（崩溃/MaxTurns 中断落盘）→ 截掉，否则下一轮 API 必 400；
 * - 孤儿 tool_result（前一条没有 tool_use）→ 丢弃。
 */
export function sanitizeStoredMessages(messages: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const raw of messages) {
    const message = raw as StoredMessageLike | null;
    if (!message || typeof message !== "object") continue;
    if (isToolResultMessage(message)) {
      const prev = kept[kept.length - 1] as StoredMessageLike | undefined;
      if (!prev || !hasToolUseBlock(prev)) continue; // 孤儿
    }
    kept.push(raw);
  }
  while (kept.length > 0 && hasToolUseBlock(kept[kept.length - 1] as StoredMessageLike)) {
    kept.pop(); // 尾部悬挂 tool_use
  }
  return kept;
}

function sanitizePayload(payload: SessionSnapshotPayload | null): SessionSnapshotPayload | null {
  if (!payload) return null;
  const messages = sanitizeStoredMessages(Array.isArray(payload.messages) ? payload.messages : []);
  return { ...payload, messages, message_count: messages.length };
}

function readPayload(path: string): SessionSnapshotPayload | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SessionSnapshotPayload;
  } catch {
    return null;
  }
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

  const toItem = (data: SessionSnapshotPayload, fallbackId: string, fallbackCreated: number): SessionListItem => ({
    session_id: data.session_id || fallbackId,
    summary: data.summary || extractSummary((data.messages ?? []) as StoredMessageLike[]),
    message_count: data.message_count ?? (data.messages?.length ?? 0),
    model: data.model ?? "",
    created_at: data.created_at ?? fallbackCreated,
  });

  for (const path of named) {
    const data = readPayload(path);
    if (!data) continue;
    const item = toItem(data, basename(path, ".json").replace(/^session-/, ""), statSync(path).mtimeMs / 1000);
    seenIds.add(item.session_id);
    sessions.push(item);
    if (sessions.length >= limit) break;
  }

  const latestPath = join(sessionDir, "latest.json");
  if (existsSync(latestPath) && sessions.length < limit) {
    const data = readPayload(latestPath);
    if (data && !seenIds.has(data.session_id || "latest")) {
      const item = toItem(data, "latest", statSync(latestPath).mtimeMs / 1000);
      if (!item.summary) item.summary = "(latest session)";
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
    const data = readPayload(latestPath);
    if (data?.session_id === sessionId) {
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
    if (data && (data.session_id === sessionId || sessionId === "latest")) return sanitizePayload(data);
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
