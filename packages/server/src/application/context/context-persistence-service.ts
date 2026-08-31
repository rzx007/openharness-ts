import { randomUUID } from "node:crypto";

import {
  decideExplicitCommit,
  detectContextConflict,
  normalizeContextContent,
  routeContextTopic,
  validateKindScope,
  type ContextEntryRecord,
  type ContextEntryStatus,
  type ContextKind,
  type ContextProposal,
  type ContextScope,
  type ContextTopic,
} from "@openharness/context";
import type { MarkdownContextStore } from "@openharness/services/context";

import { ContextIntentResolver, type ContextRuntimeScope } from "./context-intent-resolver.js";
import { detectContextSensitivity } from "./context-sensitive-data.js";

export interface RememberContextInput {
  content: string;
  runtimeScope: ContextRuntimeScope;
  sourceSessionId?: string;
  sourceMessageId?: string;
}

export type ContextPersistenceItemResult =
  | { status: "committed"; entry: ContextEntryRecord }
  | { status: "noop"; existingId: string }
  | { status: "clarification"; reason: string; proposal: ContextProposal }
  | { status: "rejected"; reason: string; proposal: ContextProposal }
  | { status: "failed"; reason: string; proposal: ContextProposal };

export interface ContextPersistenceResult {
  status: "completed";
  results: ContextPersistenceItemResult[];
}

export interface ContextPersistenceServiceOptions {
  store: MarkdownContextStore;
  resolver: ContextIntentResolver;
  now?: () => number;
  createId?: () => string;
}

export class ContextPersistenceService {
  private readonly store: ContextPersistenceServiceOptions["store"];
  private readonly resolver: ContextIntentResolver;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: ContextPersistenceServiceOptions) {
    this.store = options.store;
    this.resolver = options.resolver;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `ctx-${randomUUID()}`);
  }

  async remember(input: RememberContextInput): Promise<ContextPersistenceResult> {
    const proposals = await this.resolver.resolve(input.content, input.runtimeScope);
    const results: ContextPersistenceItemResult[] = [];
    for (const proposal of proposals) {
      try {
        results.push(await this.commitProposal(proposal, input));
      } catch (error) {
        results.push({
          status: "failed",
          reason: error instanceof Error ? error.message : "Context persistence failed",
          proposal,
        });
      }
    }
    return { status: "completed", results };
  }

  async list(input: {
    runtimeScope: ContextRuntimeScope;
    scope?: ContextScope;
    kind?: ContextKind;
    status?: ContextEntryStatus;
  }): Promise<ContextEntryRecord[]> {
    const refs = this.scopeRefs(input.runtimeScope).filter((ref) => !input.scope || ref.scope === input.scope);
    const entries = (await Promise.all(refs.map((ref) => this.store.list({ ...ref, status: input.status })))).flat();
    return entries.filter((entry) => !input.kind || entry.kind === input.kind);
  }

  async get(input: {
    runtimeScope: ContextRuntimeScope;
    id: string;
    status?: ContextEntryStatus;
  }): Promise<ContextEntryRecord | undefined> {
    return (await this.locate(input.runtimeScope, input.id, input.status ?? "active"))?.entry;
  }

  async recall(input: { runtimeScope: ContextRuntimeScope; query?: string }) {
    const entries = await this.list({ runtimeScope: input.runtimeScope });
    const query = input.query?.trim().toLocaleLowerCase("en-US");
    return {
      status: "completed" as const,
      entries: entries
        .filter((entry) => !query || `${entry.title}\n${entry.content}\n${entry.semanticKey}`.toLocaleLowerCase("en-US").includes(query))
        .map(recallContextEntry),
    };
  }

  async update(input: {
    runtimeScope: ContextRuntimeScope;
    id: string;
    content: string;
    title?: string;
  }) {
    const sensitivity = detectContextSensitivity(input.content);
    if (sensitivity === "secret") return { status: "rejected" as const, reason: "secret", id: input.id };
    if (sensitivity === "sensitive") return { status: "clarification" as const, reason: "sensitive", id: input.id };
    const located = await this.locate(input.runtimeScope, input.id, "active");
    if (!located) return { status: "not_found" as const, id: input.id };
    const entry = {
      ...located.entry,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      content: input.content.trim(),
      normalizedContent: normalizeContextContent(input.content),
      updatedAt: this.now(),
    };
    await this.store.update(entry);
    return { status: "committed" as const, entry };
  }

  async forget(input: { runtimeScope: ContextRuntimeScope; id: string }) {
    const located = await this.locate(input.runtimeScope, input.id, "active");
    if (!located) return { status: "not_found" as const, id: input.id };
    await this.store.forget({ ...located.ref, id: input.id });
    return { status: "forgotten" as const, id: input.id };
  }

  async resolve(input: {
    runtimeScope: ContextRuntimeScope;
    id: string;
    action: "accept" | "reject";
    topic?: string;
  }) {
    const located = await this.locate(input.runtimeScope, input.id, "candidate");
    if (!located) return { status: "not_found" as const, id: input.id };
    if (input.action === "reject") {
      await this.store.forget({ ...located.ref, id: input.id });
      return { status: "rejected" as const, id: input.id };
    }
    const topic = input.topic && isContextTopic(input.topic)
      ? input.topic
      : routeContextTopic({ ...located.entry, evidence: located.entry.content, replace: false });
    const entry = await this.store.acceptCandidate({ ...located.ref, id: input.id, topic });
    return { status: "committed" as const, entry };
  }

  private async commitProposal(
    proposal: ContextProposal,
    input: RememberContextInput,
  ): Promise<ContextPersistenceItemResult> {
    if (proposal.sensitivity === "secret") return { status: "rejected", reason: "secret", proposal };
    const scopeValidation = validateKindScope(proposal.kind, proposal.scope);
    if (!scopeValidation.valid) return { status: "clarification", reason: "invalid_scope", proposal };
    const scopeResolved = Boolean(proposal.scopeKey);
    if (!scopeResolved) return { status: "clarification", reason: "scope_unresolved", proposal };

    const scopeKey = proposal.scopeKey as string;
    const existing = (await this.store.list({ scope: proposal.scope, scopeKey }))
      .find((entry) => entry.semanticKey === proposal.semanticKey);
    const conflict = detectContextConflict(existing, proposal);
    if (conflict.status === "noop") return { status: "noop", existingId: conflict.existingId };
    const decision = decideExplicitCommit({
      confidence: proposal.confidence,
      sensitivity: proposal.sensitivity,
      scopeResolved,
      conflicts: conflict.status === "conflict",
    });
    if (decision.action === "reject") return { status: "rejected", reason: decision.reason, proposal };
    if (decision.action === "clarify") return { status: "clarification", reason: decision.reason, proposal };

    const now = this.now();
    const entry: ContextEntryRecord = {
      id: this.createId(),
      title: proposal.title,
      scope: proposal.scope,
      scopeKey,
      kind: proposal.kind,
      semanticKey: proposal.semanticKey,
      topic: routeContextTopic(proposal),
      content: proposal.content,
      normalizedContent: normalizeContextContent(proposal.content),
      status: "active",
      sensitivity: proposal.sensitivity,
      confidence: proposal.confidence,
      importance: defaultImportance(proposal.scope),
      origin: "explicit_user",
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      ...(conflict.status === "replace" ? { supersedesId: conflict.existingId } : {}),
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsertMany([entry]);
    return { status: "committed", entry };
  }

  private scopeRefs(runtimeScope: ContextRuntimeScope) {
    return [
      { scope: "user" as const, scopeKey: runtimeScope.userScopeKey },
      ...(runtimeScope.machineId ? [{ scope: "machine" as const, scopeKey: runtimeScope.machineId }] : []),
      ...(runtimeScope.projectId ? [{ scope: "project" as const, scopeKey: runtimeScope.projectId }] : []),
    ];
  }

  private async locate(runtimeScope: ContextRuntimeScope, id: string, status?: ContextEntryStatus) {
    for (const ref of this.scopeRefs(runtimeScope)) {
      const entry = status
        ? (await this.store.list({ ...ref, status })).find((candidate) => candidate.id === id)
        : await this.store.get({ ...ref, id });
      if (entry) return { ref, entry };
    }
    return undefined;
  }
}

function defaultImportance(scope: ContextScope): number {
  return scope === "project" ? 0.9 : 0.8;
}

export function publicContextEntry(entry: ContextEntryRecord) {
  const { id, title, scope, kind, semanticKey, content, status, updatedAt } = entry;
  return { id, title, scope, kind, semanticKey, content, status, updatedAt };
}

function recallContextEntry(entry: ContextEntryRecord) {
  const { id, title, scope, kind, semanticKey, content, updatedAt } = entry;
  return { id, title, scope, kind, semanticKey, content, updatedAt };
}

function isContextTopic(value: string): value is ContextTopic {
  return ["preferences", "ui-design", "development-workflow", "rules", "knowledge", "environment"].includes(value);
}
