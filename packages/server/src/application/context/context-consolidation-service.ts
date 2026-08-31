import {
  normalizeContextContent,
  type ContextEntryRecord,
  type ContextScope,
} from "@openharness/context";
import type { ContextBackupService, ContextDocumentRef, MarkdownContextStore } from "@openharness/services/context";

import { detectContextSensitivity } from "./context-sensitive-data.js";

export type ContextConsolidationOperation =
  | { type: "merge"; sourceIds: string[]; content: string; title?: string }
  | { type: "update"; id: string; content: string; title?: string }
  | { type: "disable"; id: string };

export interface ContextConsolidationPlanner {
  plan(entries: Array<Pick<ContextEntryRecord, "id" | "title" | "topic" | "kind" | "semanticKey" | "content" | "importance" | "updatedAt">>): Promise<unknown[]>;
}

/** Safe default: only collapses entries that already share one semantic key. */
export class DeterministicContextConsolidationPlanner implements ContextConsolidationPlanner {
  async plan(entries: Parameters<ContextConsolidationPlanner["plan"]>[0]): Promise<ContextConsolidationOperation[]> {
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) groups.set(entry.semanticKey, [...(groups.get(entry.semanticKey) ?? []), entry]);
    return [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => {
        const latest = [...group].sort((left, right) => right.updatedAt - left.updatedAt)[0]!;
        return { type: "merge", sourceIds: group.map(({ id }) => id), title: latest.title, content: latest.content };
      });
  }
}

type ConsolidationStore = Pick<MarkdownContextStore, "list" | "update" | "upsertMany">;
type ConsolidationBackup = Pick<ContextBackupService, "create">;

export class ContextConsolidationService {
  private readonly now: () => number;

  constructor(private readonly options: {
    store: ConsolidationStore;
    backup: ConsolidationBackup;
    planner: ContextConsolidationPlanner;
    now?: () => number;
    maxOperations?: number;
  }) {
    this.now = options.now ?? Date.now;
  }

  async consolidate(input: { scope: ContextScope; scopeKey: string; preview?: boolean }) {
    const entries = await this.options.store.list({ scope: input.scope, scopeKey: input.scopeKey });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const raw = await this.options.planner.plan(entries.map(({ id, title, topic, kind, semanticKey, content, importance, updatedAt }) => ({
      id, title, topic, kind, semanticKey, content, importance, updatedAt,
    })));
    const operations = validateOperations(raw, byId, this.options.maxOperations ?? 50);
    if (input.preview) return { preview: true, operations, results: [] as OperationResult[] };

    const refs = affectedDocumentRefs(operations, byId);
    const backup = await this.options.backup.create(refs);
    const results: OperationResult[] = [];
    for (const [index, operation] of operations.entries()) {
      try {
        await this.apply(operation, byId);
        results.push({ index, status: "applied" });
      } catch (error) {
        results.push({ index, status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { preview: false, operations, backupId: backup.id, results };
  }

  private async apply(operation: ContextConsolidationOperation, byId: Map<string, ContextEntryRecord>): Promise<void> {
    const now = this.now();
    if (operation.type === "update") {
      const current = byId.get(operation.id)!;
      const updated = updateContent(current, operation.content, operation.title, now);
      await this.options.store.update(updated);
      byId.set(updated.id, updated);
      return;
    }
    if (operation.type === "disable") {
      const current = byId.get(operation.id)!;
      const disabled = { ...current, status: "disabled" as const, updatedAt: now };
      await this.options.store.update(disabled);
      byId.set(disabled.id, disabled);
      return;
    }
    const sources = operation.sourceIds.map((id) => byId.get(id)!);
    const primary = sources[0]!;
    // Storage placement is a service decision. The planner never names a file.
    const targetTopic = primary.topic;
    const merged = { ...updateContent(primary, operation.content, operation.title, now), topic: targetTopic };
    const changed = [merged, ...sources.slice(1).map((entry) => ({ ...entry, status: "disabled" as const, updatedAt: now }))];
    await this.options.store.upsertMany(changed);
    for (const entry of changed) byId.set(entry.id, entry);
  }
}

interface OperationResult { index: number; status: "applied" | "failed"; error?: string }

function updateContent(entry: ContextEntryRecord, content: string, title: string | undefined, now: number): ContextEntryRecord {
  return { ...entry, ...(title ? { title } : {}), content, normalizedContent: normalizeContextContent(content), updatedAt: now };
}

function validateOperations(raw: unknown[], byId: Map<string, ContextEntryRecord>, max: number): ContextConsolidationOperation[] {
  if (!Array.isArray(raw) || raw.length > max) throw new Error("Invalid context consolidation operation count");
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid context consolidation operation");
    const record = value as Record<string, unknown>;
    if (containsForbiddenStorageKey(record)) throw new Error("Context consolidation output must not contain storage paths");
    if (record.type === "disable") {
      assertKeys(record, ["type", "id"]);
      const id = requiredString(record.id, "id");
      requireEntry(byId, id);
      return { type: "disable", id };
    }
    if (record.type === "update") {
      assertKeys(record, ["type", "id", "content", "title"]);
      const id = requiredString(record.id, "id");
      requireEntry(byId, id);
      return { type: "update", id, content: safeContent(record.content), ...(optionalString(record.title) ? { title: optionalString(record.title) } : {}) };
    }
    if (record.type === "merge") {
      assertKeys(record, ["type", "sourceIds", "content", "title"]);
      if (!Array.isArray(record.sourceIds) || record.sourceIds.length < 2) throw new Error("Merge requires at least two source ids");
      const sourceIds = record.sourceIds.map((id) => requiredString(id, "source id"));
      for (const id of sourceIds) requireEntry(byId, id);
      return { type: "merge", sourceIds, content: safeContent(record.content), ...(optionalString(record.title) ? { title: optionalString(record.title) } : {}) };
    }
    throw new Error("Unsupported context consolidation operation");
  });
}

function affectedDocumentRefs(operations: ContextConsolidationOperation[], byId: Map<string, ContextEntryRecord>): ContextDocumentRef[] {
  const ids = operations.flatMap((operation) => operation.type === "merge" ? operation.sourceIds : [operation.id]);
  return [...new Map(ids.map((id) => {
    const entry = byId.get(id)!;
    const ref = { scope: entry.scope, scopeKey: entry.scopeKey, topic: entry.topic };
    return [`${ref.scope}:${ref.scopeKey}:${ref.topic}`, ref];
  })).values()];
}

function safeContent(value: unknown): string {
  const content = requiredString(value, "content");
  if (detectContextSensitivity(content) !== "none") throw new Error("Sensitive content is not allowed in consolidation output");
  return content;
}

function requireEntry(entries: Map<string, ContextEntryRecord>, id: string): void {
  if (!entries.has(id)) throw new Error(`Unknown context entry id: ${id}`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value, "title");
}

function assertKeys(record: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Unknown context consolidation operation field");
}

function containsForbiddenStorageKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenStorageKey);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => /^(?:path|directory|root|file)$/iu.test(key) || containsForbiddenStorageKey(nested));
}
