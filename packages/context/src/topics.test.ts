import { describe, expect, it } from "vitest";

import type { ContextProposal } from "./types.js";
import { routeContextTopic } from "./topics.js";

function proposal(overrides: Partial<ContextProposal>): ContextProposal {
  return {
    title: "偏好",
    content: "内容",
    kind: "user_preference",
    scope: "user",
    semanticKey: "response.verbosity",
    confidence: 1,
    sensitivity: "none",
    evidence: "内容",
    replace: false,
    ...overrides,
  };
}

describe("routeContextTopic", () => {
  it.each([
    [proposal({ semanticKey: "ui.design.shadows" }), "ui-design"],
    [proposal({ semanticKey: "response.verbosity" }), "preferences"],
    [proposal({ semanticKey: "node.package_manager" }), "development-workflow"],
    [proposal({ kind: "project_rule", scope: "project", scopeKey: "p1" }), "rules"],
    [proposal({ kind: "project_knowledge", scope: "project", scopeKey: "p1" }), "knowledge"],
    [proposal({ kind: "environment_fact", scope: "machine", scopeKey: "m1" }), "environment"],
  ] as const)("routes a proposal to %s", (input, topic) => {
    expect(routeContextTopic(input)).toBe(topic);
  });
});
