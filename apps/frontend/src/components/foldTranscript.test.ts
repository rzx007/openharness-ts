import { describe, it, expect } from "vitest";
import { foldTranscript } from "./ConversationView.js";
import type { TranscriptItem } from "../types";

const u = (text: string): TranscriptItem => ({ role: "user", text });
const a = (text: string): TranscriptItem => ({ role: "assistant", text });
const t = (name: string): TranscriptItem => ({ role: "tool", text: "", tool_name: name });
const r = (): TranscriptItem => ({ role: "tool_result", text: "out" });

describe("foldTranscript (E.3 tool 行折叠)", () => {
  it("folds earlier tool runs into summaries, keeps the latest run expanded", () => {
    const cells = foldTranscript([
      u("q1"), t("Read"), r(), t("Grep"), r(), a("a1"),
      u("q2"), t("Bash"), r(),
    ]);
    const folded = cells.filter((c) => c.kind === "folded");
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ count: 2, names: ["Read", "Grep"] });
    // 最新一组(Bash)保持展开
    const expandedToolNames = cells
      .filter((c): c is Extract<typeof c, { kind: "item" }> => c.kind === "item")
      .filter((c) => c.item.role === "tool")
      .map((c) => c.item.tool_name);
    expect(expandedToolNames).toEqual(["Bash"]);
  });

  it("dedups names in the summary and passes through tool-free transcripts", () => {
    const cells = foldTranscript([u("q"), t("Read"), r(), t("Read"), r(), a("a"), u("q2"), t("Grep"), r()]);
    const folded = cells.find((c) => c.kind === "folded")!;
    expect(folded).toMatchObject({ count: 2, names: ["Read"] });

    expect(foldTranscript([u("hi"), a("hello")]).every((c) => c.kind === "item")).toBe(true);
  });
});
