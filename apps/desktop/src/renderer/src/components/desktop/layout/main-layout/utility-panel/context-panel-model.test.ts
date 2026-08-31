import { describe, expect, it } from "vitest";

import type { ContextEntryRecord } from "@shared/context-types";
import {
  describeContextSource,
  filterContextEntries,
} from "./context-panel-model";

const entry = (patch: Partial<ContextEntryRecord>): ContextEntryRecord => ({
  id: "entry-1",
  title: "回答风格",
  scope: "user",
  scopeKey: "user",
  kind: "user_preference",
  semanticKey: "response-style",
  topic: "preferences",
  content: "回答尽量简洁",
  status: "active",
  sensitivity: "none",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...patch,
});

describe("context panel model", () => {
  it("filters by logical scope and kind, then places the freshest entry first", () => {
    const entries = [
      entry({ id: "old", updatedAt: 10 }),
      entry({
        id: "project",
        scope: "project",
        kind: "project_rule",
        updatedAt: 30,
      }),
      entry({ id: "new", updatedAt: 20 }),
    ];

    expect(
      filterContextEntries(entries, {
        scope: "user",
        kind: "user_preference",
      }).map((x) => x.id),
    ).toEqual(["new", "old"]);
  });

  it("describes provenance without exposing a storage path", () => {
    const text = describeContextSource(entry({ sourceSessionId: "session-7" }));
    expect(text).toContain("会话 session-7");
    expect(text).not.toMatch(/[A-Z]:\\|\/context\//i);
  });
});
