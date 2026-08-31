import { describe, expect, it } from "vitest";

import type { ContextEntryRecord, ContextProposal } from "./types.js";
import { detectContextConflict } from "./conflicts.js";

const existing: ContextEntryRecord = {
  id: "ctx-package-manager",
  title: "包管理器",
  scope: "project",
  scopeKey: "project-1",
  kind: "project_rule",
  semanticKey: "node.package_manager",
  topic: "rules",
  content: "当前项目使用 npm。",
  normalizedContent: "当前项目使用 npm",
  status: "active",
  sensitivity: "none",
  confidence: 1,
  importance: 0.8,
  origin: "explicit_user",
  useCount: 0,
  createdAt: 1,
  updatedAt: 1,
};

function proposal(content: string, replace = false): ContextProposal {
  return {
    title: "包管理器",
    content,
    kind: "project_rule",
    scope: "project",
    scopeKey: "project-1",
    semanticKey: "node.package_manager",
    confidence: 0.99,
    sensitivity: "none",
    evidence: content,
    replace,
  };
}

describe("detectContextConflict", () => {
  it("returns noop for normalized-equivalent content", () => {
    expect(detectContextConflict(existing, proposal("  当前项目使用 NPM  ")))
      .toEqual({ status: "noop", existingId: existing.id });
  });

  it("returns conflict for different content in the same semantic slot", () => {
    expect(detectContextConflict(existing, proposal("当前项目使用 pnpm。")))
      .toEqual({ status: "conflict", existingId: existing.id });
  });

  it("returns replace only when the explicit request asks to replace", () => {
    expect(detectContextConflict(existing, proposal("当前项目使用 pnpm。", true)))
      .toEqual({ status: "replace", existingId: existing.id });
  });
});
