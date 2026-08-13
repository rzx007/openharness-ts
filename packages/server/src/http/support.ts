import { runtimeMetadataChanged } from "@openharness/services";
import type { Context } from "hono";

export type JsonRecord = Record<string, unknown>;

export type HttpPermissionStatus = "pending" | "approved" | "denied" | "expired";

export interface OpenHarnessServerHealth {
  ok: true;
  version?: string;
  startedAt: number;
  uptimeMs: number;
  sessionCount: number;
  activeRunCount: number;
  queuedRunCount: number;
}

export interface OpenHarnessRuntimeSnapshot {
  startedAt: number;
  uptimeMs: number;
  sessions: { total: number; byStatus: Record<string, number> };
  runs: { total: number; byStatus: Record<string, number> };
  tasks: { total: number; byStatus: Record<string, number> };
  permissions: { total: number; byStatus: Record<string, number> };
  sseClientCount: number;
  warmAgentCount: number;
  coordinator: { activeRunCount: number; queuedRunCount: number };
}

export type SseClient = {
  sessionId?: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat?: ReturnType<typeof setInterval>;
};

export const DAEMON_RESTART_RUN_REASON = "Daemon restarted before the run completed";
export const DAEMON_RESTART_TASK_REASON = "Daemon restarted before the task completed";
export const DAEMON_RESTART_PERMISSION_REASON = "Daemon restarted before the permission was resolved";
export const DAEMON_RESTART_WORKFLOW_REASON = "Daemon restarted before the workflow completed";

export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
export const SSE_HEADERS = {
  "cache-control": "no-cache",
  "connection": "keep-alive",
  "content-type": "text/event-stream; charset=utf-8",
};
export const CORS_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
export const CORS_HEADERS = "authorization, content-type, last-event-id, x-openharness-trace-id";

export function runtimeSessionMetadataChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return runtimeMetadataChanged(before, after);
}

export function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeTraceId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : undefined;
}

export function withoutTraceId(metadata: Record<string, unknown>): Record<string, unknown> {
  const { traceId: _traceId, ...rest } = metadata;
  return rest;
}

export function countByStatus(records: ReadonlyArray<{ status: string }>): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }, {});
}

export function normalizeAllowedOrigins(origins: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const value of origins) {
    if (value === "*") throw new Error("Wildcard CORS origins are not supported");
    let origin: URL;
    try {
      origin = new URL(value);
    } catch {
      throw new Error(`Invalid allowed origin: ${value}`);
    }
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== value.replace(/\/$/, "")) {
      throw new Error(`Allowed origin must be an http(s) origin without a path: ${value}`);
    }
    normalized.add(origin.origin);
  }
  return normalized;
}

export function workflowRunIdFromSessionEvent(event: { payload: Record<string, unknown> }): string | undefined {
  const workflowEvent = event.payload.event;
  return isRecord(workflowEvent) && typeof workflowEvent.runId === "string"
    ? workflowEvent.runId
    : undefined;
}

export function readLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function readCursor(c: Context): number | undefined {
  return readLimit(c.req.query("cursor") ?? c.req.query("afterSeq"));
}

export function readEventCursor(c: Context): number | undefined {
  return readCursor(c) ?? readLimit(c.req.header("last-event-id"));
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]),
    );
  }
  return false;
}

export function readPermissionStatus(value: string | undefined): HttpPermissionStatus | undefined {
  if (!value) return undefined;
  if (value === "pending" || value === "approved" || value === "denied" || value === "expired") return value;
  throw new Error("Invalid permission status");
}

export function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      ...JSON_HEADERS,
      "content-length": String(Buffer.byteLength(text)),
    },
  });
}

export function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

export function sessionMutationErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Session is archived:") ||
    message.startsWith("Session is closing:") ||
    message.startsWith("Prompt id is already used:")
    ? 409
    : 404;
}

export async function readJson(c: Context): Promise<JsonRecord> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new Error("Request body too large");
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error("Request body must be a JSON object");
  return parsed;
}
