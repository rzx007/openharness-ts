import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  listDocumentEntries,
  parseContextDocument,
  renderContextDocument,
  type ContextDocumentSegment,
  type ContextEntryRecord,
  type ContextEntryStatus,
  type ContextScope,
  type ContextTopic,
  type ContextTopicDocument,
} from "@openharness/context";

import { ContextScopeLock } from "./context-lock.js";
import { ContextPaths, type ContextDocumentRef, type ContextScopeRef } from "./context-paths.js";

const DAY_MS = 86_400_000;
const TOPIC_TITLES: Record<ContextTopic, string> = {
  preferences: "用户偏好",
  "ui-design": "UI 设计偏好",
  "development-workflow": "开发工作流",
  rules: "项目规则",
  knowledge: "项目知识",
  environment: "环境事实",
  pending: "待确认内容",
};

export interface MarkdownContextStoreOptions {
  root: string;
  now?: () => number;
  candidateRetentionDays?: number;
  lock?: ContextScopeLock;
}

export interface ContextListQuery extends ContextScopeRef {
  status?: ContextEntryStatus;
}

export class MarkdownContextStore {
  readonly paths: ContextPaths;
  private readonly now: () => number;
  private readonly candidateRetentionDays: number;
  private readonly lock: ContextScopeLock;
  private readonly touchedScopes = new Map<string, ContextScopeRef>();

  constructor(options: MarkdownContextStoreOptions) {
    this.paths = new ContextPaths(options.root);
    this.now = options.now ?? Date.now;
    this.candidateRetentionDays = options.candidateRetentionDays ?? 30;
    this.lock = options.lock ?? new ContextScopeLock();
  }

  async upsertMany(entries: ContextEntryRecord[]): Promise<void> {
    const byScope = groupBy(entries, (entry) => `${entry.scope}:${entry.scopeKey}`);
    for (const scopedEntries of byScope.values()) {
      const first = scopedEntries[0];
      if (!first) continue;
      await this.lock.run(first.scope, first.scopeKey, async () => {
        const byTopic = groupBy(scopedEntries, (entry) => entry.topic);
        for (const [topic, topicEntries] of byTopic) {
          const ref = { scope: first.scope, scopeKey: first.scopeKey, topic: topic as ContextTopic };
          const document = await this.readDocument(ref);
          for (const entry of topicEntries) upsertEntry(document, entry);
          document.updatedAt = this.now();
          await this.writeDocument(ref, document);
        }
      });
      this.rememberScope(first);
    }
  }

  async update(entry: ContextEntryRecord): Promise<void> {
    await this.lock.run(entry.scope, entry.scopeKey, async () => {
      const ref = pickDocumentRef(entry);
      const document = await this.readDocument(ref);
      const current = listDocumentEntries(document).find(({ id }) => id === entry.id);
      if (!current) throw new Error(`Context entry not found: ${entry.id}`);
      replaceEntry(document, { ...entry, createdAt: current.createdAt });
      document.updatedAt = this.now();
      await this.writeDocument(ref, document);
    });
    this.rememberScope(entry);
  }

  async forget(input: ContextScopeRef & { id: string }): Promise<boolean> {
    const removed = await this.lock.run(input.scope, input.scopeKey, async () => {
      for (const topic of this.paths.topicsFor(input.scope)) {
        const ref = { ...input, topic };
        const document = await this.readDocument(ref, true);
        if (!document || !removeEntry(document, input.id)) continue;
        document.updatedAt = this.now();
        await this.writeDocument(ref, document);
        return true;
      }
      return false;
    });
    this.rememberScope(input);
    return removed;
  }

  async list(query: ContextListQuery): Promise<ContextEntryRecord[]> {
    const status = query.status ?? "active";
    const entries: ContextEntryRecord[] = [];
    for (const topic of this.paths.topicsFor(query.scope)) {
      const document = await this.readDocument({ ...query, topic }, true);
      if (document) entries.push(...listDocumentEntries(document).filter((entry) => entry.status === status));
    }
    return entries.sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id));
  }

  async get(input: ContextScopeRef & { id: string }): Promise<ContextEntryRecord | undefined> {
    for (const topic of this.paths.topicsFor(input.scope)) {
      const document = await this.readDocument({ ...input, topic }, true);
      const entry = document && listDocumentEntries(document).find(({ id }) => id === input.id);
      if (entry) return entry;
    }
    return undefined;
  }

  async acceptCandidate(input: ContextScopeRef & { id: string; topic: ContextTopic }): Promise<ContextEntryRecord> {
    return this.lock.run(input.scope, input.scopeKey, async () => {
      const pendingRef = { ...input, topic: "pending" as const };
      const pending = await this.readDocument(pendingRef);
      const candidate = listDocumentEntries(pending).find(({ id }) => id === input.id);
      if (!candidate) throw new Error(`Context candidate not found: ${input.id}`);
      const accepted = { ...candidate, topic: input.topic, status: "active" as const, updatedAt: this.now() };
      const targetRef = { ...input, topic: input.topic };
      const target = await this.readDocument(targetRef);
      upsertEntry(target, accepted);
      target.updatedAt = this.now();
      await this.writeDocument(targetRef, target);
      removeEntry(pending, input.id);
      pending.updatedAt = this.now();
      await this.writeDocument(pendingRef, pending);
      this.rememberScope(input);
      return accepted;
    });
  }

  async cleanupExpiredCandidates(): Promise<number> {
    await this.discoverScopes();
    const cutoff = this.now() - this.candidateRetentionDays * DAY_MS;
    let removed = 0;
    for (const scope of this.touchedScopes.values()) {
      await this.lock.run(scope.scope, scope.scopeKey, async () => {
        const ref = { ...scope, topic: "pending" as const };
        const document = await this.readDocument(ref, true);
        if (!document) return;
        for (const entry of listDocumentEntries(document)) {
          if (entry.status === "candidate" && entry.updatedAt < cutoff && removeEntry(document, entry.id)) removed += 1;
        }
        if (removed > 0) {
          document.updatedAt = this.now();
          await this.writeDocument(ref, document);
        }
      });
    }
    return removed;
  }

  private async readDocument(ref: ContextDocumentRef, missingAsUndefined: true): Promise<ContextTopicDocument | undefined>;
  private async readDocument(ref: ContextDocumentRef, missingAsUndefined?: false): Promise<ContextTopicDocument>;
  private async readDocument(
    ref: ContextDocumentRef,
    missingAsUndefined = false,
  ): Promise<ContextTopicDocument | undefined> {
    const path = this.paths.documentFor(ref);
    try {
      return parseContextDocument(await readFile(path, "utf8"));
    } catch (error) {
      if (isMissing(error)) {
        if (missingAsUndefined) return undefined;
        return createDocument(ref, this.now());
      }
      throw new Error(`Invalid managed context document: ${basename(path)}`, { cause: error });
    }
  }

  private async writeDocument(ref: ContextDocumentRef, document: ContextTopicDocument): Promise<void> {
    const path = this.paths.documentFor(ref);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const rendered = renderContextDocument(document);
    await writeFile(temporaryPath, rendered, "utf8");
    const verified = parseContextDocument(await readFile(temporaryPath, "utf8"));
    const expectedIds = listDocumentEntries(document).map(({ id }) => id);
    const actualIds = listDocumentEntries(verified).map(({ id }) => id);
    if (expectedIds.join("\0") !== actualIds.join("\0")) throw new Error("Context document verification failed");
    await rename(temporaryPath, path);
  }

  private rememberScope(ref: ContextScopeRef): void {
    this.touchedScopes.set(`${ref.scope}:${ref.scopeKey}`, { scope: ref.scope, scopeKey: ref.scopeKey });
  }

  private async discoverScopes(): Promise<void> {
    this.rememberScope({ scope: "user", scopeKey: "local-user" });
    for (const [scope, directory] of [["machine", "machine"], ["project", "projects"]] as const) {
      try {
        for (const item of await readdir(join(this.paths.root, directory), { withFileTypes: true })) {
          if (item.isDirectory()) this.rememberScope({ scope, scopeKey: item.name });
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
}

function createDocument(ref: ContextDocumentRef, now: number): ContextTopicDocument {
  return { schemaVersion: 2, ...ref, title: TOPIC_TITLES[ref.topic], updatedAt: now, segments: [] };
}

function upsertEntry(document: ContextTopicDocument, entry: ContextEntryRecord): void {
  if (entry.status === "active") {
    for (const current of listDocumentEntries(document)) {
      if (current.id !== entry.id && current.semanticKey === entry.semanticKey && current.status === "active") {
        replaceEntry(document, { ...current, status: "superseded", updatedAt: entry.updatedAt });
      }
    }
  }
  if (!replaceEntry(document, entry)) document.segments.push({ type: "entry", entry });
}

function replaceEntry(document: ContextTopicDocument, entry: ContextEntryRecord): boolean {
  const segment = document.segments.find(
    (candidate): candidate is Extract<ContextDocumentSegment, { type: "entry" }> =>
      candidate.type === "entry" && candidate.entry.id === entry.id,
  );
  if (!segment) return false;
  segment.entry = entry;
  return true;
}

function removeEntry(document: ContextTopicDocument, id: string): boolean {
  const index = document.segments.findIndex((segment) => segment.type === "entry" && segment.entry.id === id);
  if (index < 0) return false;
  document.segments.splice(index, 1);
  return true;
}

function groupBy<T>(values: T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(keyOf(value), [...(groups.get(keyOf(value)) ?? []), value]);
  return groups;
}

function pickDocumentRef(entry: ContextEntryRecord): ContextDocumentRef {
  return { scope: entry.scope, scopeKey: entry.scopeKey, topic: entry.topic };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
