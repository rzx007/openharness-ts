import type { ContextKind, ContextScope, ContextSensitivity } from "./types.js";

const EXPLICIT_COMMIT_CONFIDENCE = 0.85;
const AUTOMATIC_COMMIT_CONFIDENCE = 0.95;

const ALLOWED_SCOPES: Record<ContextKind, readonly ContextScope[]> = {
  user_preference: ["user"],
  project_rule: ["project"],
  project_knowledge: ["project"],
  environment_fact: ["machine", "project"],
};

export function validateKindScope(kind: ContextKind, scope: ContextScope): { valid: boolean; reason?: string } {
  const valid = ALLOWED_SCOPES[kind].includes(scope);
  return valid ? { valid: true } : { valid: false, reason: `${kind} cannot use ${scope} scope` };
}

interface CommitPolicyInput {
  confidence: number;
  sensitivity: ContextSensitivity;
  scopeResolved: boolean;
  conflicts: boolean;
}

export type ExplicitCommitDecision =
  | { action: "commit" }
  | { action: "clarify"; reason: "low_confidence" | "scope_unresolved" | "conflict" | "sensitive" }
  | { action: "reject"; reason: "secret" };

export function decideExplicitCommit(input: CommitPolicyInput): ExplicitCommitDecision {
  if (input.sensitivity === "secret") return { action: "reject", reason: "secret" };
  if (input.sensitivity === "sensitive") return { action: "clarify", reason: "sensitive" };
  if (!input.scopeResolved) return { action: "clarify", reason: "scope_unresolved" };
  if (input.conflicts) return { action: "clarify", reason: "conflict" };
  if (input.confidence < EXPLICIT_COMMIT_CONFIDENCE) return { action: "clarify", reason: "low_confidence" };
  return { action: "commit" };
}

export function decideAutomaticCandidate(
  input: CommitPolicyInput & { kind: ContextKind },
): "commit" | "candidate" | "reject" {
  if (input.sensitivity === "secret") return "reject";
  if (
    input.kind === "environment_fact"
    && input.confidence >= AUTOMATIC_COMMIT_CONFIDENCE
    && input.sensitivity === "none"
    && input.scopeResolved
    && !input.conflicts
  ) return "commit";
  return "candidate";
}
