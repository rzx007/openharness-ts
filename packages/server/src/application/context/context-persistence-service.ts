import { randomUUID } from "node:crypto";

import {
  decideExplicitCommit,
  detectContextConflict,
  normalizeContextContent,
  routeContextTopic,
  validateKindScope,
  type ContextEntryRecord,
  type ContextProposal,
  type ContextScope,
} from "@openharness/context";
import type { MarkdownContextStore } from "@openharness/services/context";

import { ContextIntentResolver, type ContextRuntimeScope } from "./context-intent-resolver.js";

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
  store: Pick<MarkdownContextStore, "list" | "upsertMany">;
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
}

function defaultImportance(scope: ContextScope): number {
  return scope === "project" ? 0.9 : 0.8;
}
