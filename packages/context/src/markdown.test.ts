import { describe, expect, it } from "vitest";

import type { ContextEntryRecord, ContextTopicDocument } from "./types.js";
import { listDocumentEntries, parseContextDocument, renderContextDocument } from "./markdown.js";

function entry(id: string, title: string, semanticKey: string, content: string): ContextEntryRecord {
  return {
    id,
    title,
    scope: "user",
    scopeKey: "local-user",
    kind: "user_preference",
    semanticKey,
    topic: "ui-design",
    content,
    normalizedContent: content.toLowerCase(),
    status: "active",
    sensitivity: "none",
    confidence: 0.98,
    importance: 0.9,
    origin: "explicit_user",
    sourceSessionId: "session-1",
    useCount: 0,
    createdAt: 1_788_166_800_000,
    updatedAt: 1_788_166_800_000,
  };
}

const document: ContextTopicDocument = {
  schemaVersion: 2,
  scope: "user",
  scopeKey: "local-user",
  topic: "ui-design",
  title: "UI 设计偏好",
  updatedAt: 1_788_166_800_000,
  segments: [
    { type: "text", content: "# UI 设计偏好\n\n项目已有设计系统时，以项目设计系统为准。\n\n" },
    { type: "entry", entry: entry("ctx-color", "配色", "ui.design.color_palette", "使用项目真实设计系统色板。") },
    { type: "text", content: "\n\n这段人工说明必须保留。\n\n" },
    { type: "entry", entry: entry("ctx-radius", "圆角", "ui.design.border_radius", "遵循项目规定的圆角刻度。") },
    { type: "text", content: "\n" },
  ],
};

describe("context topic markdown", () => {
  it("round-trips multiple entries and unmanaged human text", () => {
    const markdown = renderContextDocument(document);
    const parsed = parseContextDocument(markdown);

    expect(parsed).toEqual(document);
    expect(listDocumentEntries(parsed).map(({ id }) => id)).toEqual(["ctx-color", "ctx-radius"]);
  });

  it("rejects an unclosed entry block instead of silently absorbing human text", () => {
    const markdown = renderContextDocument(document).replace("<!-- /context-entry -->", "");
    expect(() => parseContextDocument(markdown)).toThrow(/unclosed context-entry/i);
  });

  it("rejects duplicate entry ids in one topic document", () => {
    const duplicate: ContextTopicDocument = {
      ...document,
      segments: [...document.segments, { type: "entry", entry: entry("ctx-color", "重复", "ui.design.duplicate", "重复。") }],
    };
    expect(() => renderContextDocument(duplicate)).toThrow(/duplicate context entry id/i);
  });
});
