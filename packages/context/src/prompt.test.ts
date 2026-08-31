import { describe, expect, it } from "vitest";

import type { ContextEntryRecord } from "./types.js";
import { renderContextPrompt } from "./prompt.js";

function entry(id: string, content: string, scope: ContextEntryRecord["scope"] = "user"): ContextEntryRecord {
  return {
    id,
    title: id,
    scope,
    scopeKey: scope === "user" ? "local-user" : `${scope}-1`,
    kind: scope === "project" ? "project_rule" : "user_preference",
    semanticKey: id,
    topic: scope === "project" ? "rules" : "preferences",
    content,
    normalizedContent: content.toLowerCase(),
    status: "active",
    sensitivity: "none",
    confidence: 1,
    importance: 0.8,
    origin: "explicit_user",
    useCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("renderContextPrompt", () => {
  it("renders logical entries without storage metadata", () => {
    const prompt = renderContextPrompt([entry("ctx-1", "回答尽量简洁。")]);
    expect(prompt).toContain("回答尽量简洁。");
    expect(prompt).toContain("ctx-1");
    expect(prompt).not.toMatch(/(?:path|directory|scopeKey)/i);
  });

  it("honors the character and entry budgets", () => {
    const entries = Array.from({ length: 60 }, (_, index) => entry(`ctx-${index}`, "x".repeat(400)));
    const prompt = renderContextPrompt(entries, { maxChars: 1_200, maxEntries: 10 });
    expect(prompt.length).toBeLessThanOrEqual(1_200);
    expect((prompt.match(/^- \[/gmu) ?? [])).toHaveLength(2);
  });
});
