import { resolve, isAbsolute, join } from "node:path";

import type { StreamingMessageClient } from "@openharness/core";
import {
  MemoryManager,
  parseMemoryType,
  parseMemoryScope,
  DEFAULT_MEMORY_TYPE,
  DEFAULT_MEMORY_SCOPE,
  type MemoryType,
  type MemoryScope,
} from "@openharness/memory";

import type { CheckpointMessageLike } from "./session-memory.js";

/**
 * 持久记忆提取（移植自 Python services/memory_extract/）。
 *
 * 回合结束后让 LLM 从最近对话提出「值得长期保存的事实」（JSON，≤3 条），
 * 写进 @openharness/memory 的 MemoryManager（签名去重由 manager 兜底）。
 * 若本回合主对话已经亲手写过 memory 目录则跳过（避免重复）。
 *
 * 与 Python 差异：team scope 记录直接跳过（TS memory 无团队隔离/密钥扫描，
 * Phase C 缺口）；written_paths 改为 writtenIds（manager 是条目模型非文件路径）。
 */

const MEMORY_WRITE_TOOLS = new Set(["Write", "Edit"]);

export interface ExtractionRecord {
  title: string;
  body: string;
  memoryType: MemoryType;
  scope: MemoryScope;
  description: string;
  tags: string[];
}

export interface ExtractionResult {
  skipped: boolean;
  reason: string;
  records: ExtractionRecord[];
  writtenIds: string[];
}

/** 本回合是否已有 Write/Edit 落在 memory 目录内（有则提取跳过）。 */
export function hasMemoryWritesSince(
  messages: CheckpointMessageLike[],
  memoryDir: string,
  cwd?: string,
): boolean {
  const root = resolve(memoryDir);
  const writeBase = cwd ? resolve(cwd) : root;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      const b = block as { type?: unknown; name?: unknown; input?: Record<string, unknown> } | null;
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      if (!MEMORY_WRITE_TOOLS.has(b.name)) continue;
      const rawPath = String(b.input?.path ?? b.input?.file_path ?? "");
      if (!rawPath) continue;
      const path = isAbsolute(rawPath) ? rawPath : join(writeBase, rawPath);
      const resolved = resolve(path);
      if (resolved === root || resolved.startsWith(root + "\\") || resolved.startsWith(root + "/")) {
        return true;
      }
    }
  }
  return false;
}

export const EXTRACTION_SYSTEM_PROMPT = `You maintain OpenHarness durable memory.
Save only stable, future-useful facts that are not derivable from current files,
git history, or documentation. Prefer updating existing memories conceptually
over duplicating them. Do not save secrets. If nothing is worth saving, return
{"memories": []}.
`;

/** 提取请求：现有记忆清单 + 最近 12 条消息摘要 + JSON schema 约束。 */
export function buildExtractionPrompt(
  existingManifest: string,
  messages: CheckpointMessageLike[],
  maxRecords = 3,
): string {
  const transcript = messages.slice(-12).map(summarizeMessage).join("\n");
  return (
    "Extract only durable memories from the recent conversation.\n" +
    `Return JSON with at most ${maxRecords} records. Existing memory manifest:\n` +
    `${existingManifest || "(empty)"}\n\n` +
    "Recent conversation:\n" +
    `${transcript}\n\n` +
    'JSON schema: {"memories":[{"title":"...","type":"user|feedback|project|reference",' +
    '"scope":"private|project|team","description":"...","body":"...","tags":["..."]}]}'
  );
}

/** 解析 LLM 输出的 JSON（容忍前后噪声文本，坏 JSON 返回空）。 */
export function parseExtractionRecords(text: string, maxRecords = 3): ExtractionRecord[] {
  let payload: unknown;
  try {
    payload = JSON.parse(extractJsonObject(text));
  } catch {
    return [];
  }
  const rawRecords =
    payload && typeof payload === "object" ? (payload as { memories?: unknown }).memories : undefined;
  if (!Array.isArray(rawRecords)) return [];

  const records: ExtractionRecord[] = [];
  for (const item of rawRecords.slice(0, maxRecords)) {
    if (!item || typeof item !== "object") continue;
    const data = item as Record<string, unknown>;
    const title = String(data.title ?? "").trim();
    const body = String(data.body ?? "").trim();
    if (!title || !body) continue;
    const tags = Array.isArray(data.tags)
      ? data.tags.map((t) => String(t).trim()).filter(Boolean)
      : [];
    records.push({
      title,
      body,
      memoryType: parseMemoryType(data.type) ?? DEFAULT_MEMORY_TYPE,
      scope: parseMemoryScope(data.scope) ?? DEFAULT_MEMORY_SCOPE,
      description: String(data.description ?? "").trim(),
      tags,
    });
  }
  return records;
}

/** 把通过的记录写进 MemoryManager（team scope 跳过——TS 无团队隔离）。 */
export async function applyExtractionRecords(
  manager: MemoryManager,
  records: ExtractionRecord[],
): Promise<ExtractionResult> {
  const writtenIds: string[] = [];
  for (const record of records) {
    if (record.scope === "team") continue;
    const entry = await manager.add(record.body, record.tags, undefined, {
      name: record.title,
      description: record.description,
      type: record.memoryType,
      scope: record.scope,
    });
    writtenIds.push(entry.id);
  }
  return {
    skipped: writtenIds.length === 0,
    reason: writtenIds.length === 0 ? "all records rejected" : "",
    records,
    writtenIds,
  };
}

export interface ExtractMemoriesOptions {
  apiClient: StreamingMessageClient;
  model: string;
  messages: CheckpointMessageLike[];
  manager: MemoryManager;
  /** 现有记忆清单文本（标题列表），进提取 prompt 防重复。 */
  existingManifest?: string;
  /** memory 落盘目录（检测本回合是否已写过）。 */
  memoryDir?: string;
  cwd?: string;
  maxRecords?: number;
}

/** 端到端：构 prompt → 调模型 → 解析 → 写入。 */
export async function extractMemoriesFromTurn(options: ExtractMemoriesOptions): Promise<ExtractionResult> {
  const { messages } = options;
  const maxRecords = options.maxRecords ?? 3;

  if (messages.length < 2) {
    return { skipped: true, reason: "not enough messages", records: [], writtenIds: [] };
  }
  if (options.memoryDir && hasMemoryWritesSince(messages, options.memoryDir, options.cwd)) {
    return { skipped: true, reason: "main conversation already wrote memory", records: [], writtenIds: [] };
  }

  const prompt = buildExtractionPrompt(options.existingManifest ?? "", messages, maxRecords);
  let finalText = "";
  for await (const event of options.apiClient.streamMessage({
    model: options.model,
    messages: [{ type: "user", content: prompt }],
    system: EXTRACTION_SYSTEM_PROMPT,
    maxTokens: 2048,
    tools: [],
  })) {
    if (event.type === "text_delta") finalText += event.delta;
    if (event.type === "complete") break;
  }

  const records = parseExtractionRecords(finalText, maxRecords);
  if (records.length === 0) {
    return { skipped: true, reason: "no durable memories proposed", records: [], writtenIds: [] };
  }
  return applyExtractionRecords(options.manager, records);
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function extractJsonObject(text: string): string {
  const stripped = text.trim();
  if (stripped.startsWith("{") && stripped.endsWith("}")) return stripped;
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) return stripped.slice(start, end + 1);
  return stripped;
}

function summarizeMessage(message: CheckpointMessageLike): string {
  const role = message.role ?? "system";
  let text = "";
  const toolUseNames: string[] = [];
  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const b = block as { type?: unknown; text?: unknown; name?: unknown } | null;
      if (typeof b?.text === "string") text += (text ? " " : "") + b.text;
      if (b?.type === "tool_use" && typeof b.name === "string") toolUseNames.push(b.name);
    }
  }
  const collapsed = text.split(/\s+/).filter(Boolean).join(" ");
  if (collapsed) return `${role}: ${collapsed.slice(0, 1200)}`;
  if (toolUseNames.length > 0) return `${role}: tool calls -> ${toolUseNames.join(", ")}`;
  return `${role}: [non-text content]`;
}
