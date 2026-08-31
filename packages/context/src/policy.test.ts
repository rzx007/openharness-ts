import { describe, expect, it } from "vitest";

import { decideAutomaticCandidate, decideExplicitCommit, validateKindScope } from "./policy.js";

describe("context policy", () => {
  it.each([
    ["user_preference", "user", true],
    ["project_rule", "project", true],
    ["project_knowledge", "project", true],
    ["environment_fact", "machine", true],
    ["environment_fact", "project", true],
    ["user_preference", "project", false],
  ] as const)("validates %s in %s scope", (kind, scope, valid) => {
    expect(validateKindScope(kind, scope).valid).toBe(valid);
  });

  it("rejects secrets regardless of confidence", () => {
    expect(decideExplicitCommit({
      confidence: 1,
      sensitivity: "secret",
      scopeResolved: true,
      conflicts: false,
    })).toEqual({ action: "reject", reason: "secret" });
  });

  it("commits explicit safe content only after scope and confidence are resolved", () => {
    expect(decideExplicitCommit({
      confidence: 0.9,
      sensitivity: "none",
      scopeResolved: true,
      conflicts: false,
    })).toEqual({ action: "commit" });
  });

  it("auto-commits only high-confidence safe environment facts", () => {
    expect(decideAutomaticCandidate({
      kind: "environment_fact",
      confidence: 0.96,
      sensitivity: "none",
      scopeResolved: true,
      conflicts: false,
    })).toBe("commit");
    expect(decideAutomaticCandidate({
      kind: "project_knowledge",
      confidence: 0.99,
      sensitivity: "none",
      scopeResolved: true,
      conflicts: false,
    })).toBe("candidate");
  });
});
