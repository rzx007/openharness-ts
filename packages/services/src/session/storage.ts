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
 * 与 Python 差异：消息形状宽松（不做 pydantic 校验）；
 * sanitize_conversation_messages 的 tool_use/result 配对修复由 compact 链路负责，
 * 存储层原样持久化。
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
  };
  const data = JSON.stringify(payload, null, 2) + "\n";

  const latestPath = join(sessionDir, "latest.json");
  atomicWrite(latestPath, data);
  atomicWrite(join(sessionDir, `session-${sid}.json`), data);
  return latestPath;
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
  return readPayload(path);
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

/** 按 ID 读会话：named 优先，latest 兜底（id 匹配或 "latest"）。 */
export function loadSessionById(cwd: string, sessionId: string): SessionSnapshotPayload | null {
  const sessionDir = getProjectSessionDir(cwd);
  const namedPath = join(sessionDir, `session-${sessionId}.json`);
  if (existsSync(namedPath)) return readPayload(namedPath);

  const latestPath = join(sessionDir, "latest.json");
  if (existsSync(latestPath)) {
    const data = readPayload(latestPath);
    if (data && (data.session_id === sessionId || sessionId === "latest")) return data;
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
