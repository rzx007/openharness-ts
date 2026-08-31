import { normalizeContextContent } from "./normalize.js";
import type { ContextConflictDecision, ContextEntryRecord, ContextProposal } from "./types.js";

export function detectContextConflict(
  existing: ContextEntryRecord | undefined,
  proposal: ContextProposal,
): ContextConflictDecision {
  if (!existing) return { status: "create" };
  if (
    existing.scope !== proposal.scope
    || existing.scopeKey !== (proposal.scopeKey ?? existing.scopeKey)
    || existing.semanticKey !== proposal.semanticKey
  ) return { status: "create" };

  if (normalizeContextContent(existing.content) === normalizeContextContent(proposal.content)) {
    return { status: "noop", existingId: existing.id };
  }
  return proposal.replace
    ? { status: "replace", existingId: existing.id }
    : { status: "conflict", existingId: existing.id };
}
