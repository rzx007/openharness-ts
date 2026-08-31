import { randomUUID } from "node:crypto";

import {
  decideAutomaticCandidate,
  normalizeContextContent,
  routeContextTopic,
  type ContextEntryRecord,
  type ContextProposal,
} from "@openharness/context";
import type { MarkdownContextStore } from "@openharness/services/context";

import type { ContextRuntimeScope } from "./context-intent-resolver.js";
import type { ContextTranscriptMessage, EnvironmentFactExtractor } from "./environment-fact-extractor.js";

export interface ContextExtractionServiceOptions {
  store: Pick<MarkdownContextStore, "upsertMany">;
  extractor: EnvironmentFactExtractor;
  now?: () => number;
  createId?: () => string;
}

export class ContextExtractionService {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: ContextExtractionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `ctx-${randomUUID()}`);
  }

  async extract(input: {
    messages: ContextTranscriptMessage[];
    runtimeScope: ContextRuntimeScope;
    sourceSessionId?: string;
  }): Promise<{ committed: number; candidates: number; rejected: number }> {
    const entries: ContextEntryRecord[] = [];
    let committed = 0;
    let candidates = 0;
    let rejected = 0;
    for (const rawProposal of this.options.extractor.extract(input.messages)) {
      const proposal = applyRuntimeScope(rawProposal, input.runtimeScope);
      const action = decideAutomaticCandidate({
        kind: proposal.kind,
        confidence: proposal.confidence,
        sensitivity: proposal.sensitivity,
        scopeResolved: Boolean(proposal.scopeKey),
        conflicts: false,
      });
      if (action === "reject" || !proposal.scopeKey) {
        rejected += 1;
        continue;
      }
      const now = this.now();
      const candidate = action === "candidate";
      entries.push({
        id: this.createId(),
        title: proposal.title,
        scope: proposal.scope,
        scopeKey: proposal.scopeKey,
        kind: proposal.kind,
        semanticKey: proposal.semanticKey,
        topic: candidate ? "pending" : routeContextTopic(proposal),
        content: proposal.content,
        normalizedContent: normalizeContextContent(proposal.content),
        status: candidate ? "candidate" : "active",
        sensitivity: proposal.sensitivity,
        confidence: proposal.confidence,
        importance: 0.6,
        origin: "automatic_extraction",
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(candidate ? { candidateReason: automaticCandidateReason(proposal) } : {}),
        useCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      if (candidate) candidates += 1;
      else committed += 1;
    }
    if (entries.length > 0) await this.options.store.upsertMany(entries);
    return { committed, candidates, rejected };
  }
}

function applyRuntimeScope(proposal: ContextProposal, scope: ContextRuntimeScope): ContextProposal {
  const scopeKey = proposal.scope === "user"
    ? scope.userScopeKey
    : proposal.scope === "machine"
      ? scope.machineId
      : scope.projectId;
  return { ...proposal, scopeKey };
}

function automaticCandidateReason(proposal: ContextProposal): string {
  if (proposal.sensitivity !== "none") return "sensitive";
  if (proposal.kind !== "environment_fact") return "kind_requires_review";
  return "confidence_below_threshold";
}
