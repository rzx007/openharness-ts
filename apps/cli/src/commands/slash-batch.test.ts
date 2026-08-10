import { describe, it, expect } from "vitest";
import { formatPromptLayersReport } from "./slash-helpers.js";

describe("slash helpers", () => {
  it("formatPromptLayersReport truncates the flat preview and keeps total length", () => {
    const report = formatPromptLayersReport({
      stable: ["A".repeat(20)],
      context: ["B".repeat(20)],
      volatile: ["C".repeat(20)],
    }, 25);
    expect(report).toContain("... (truncated)");
    expect(report).toContain("stable: 1 section(s), 20 characters");
    expect(report).toContain("Total length: 64 characters");
  });
});
