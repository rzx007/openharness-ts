import { describe, expect, it } from "vitest";

import { createContentSignature, normalizeContextContent } from "./normalize.js";

describe("normalizeContextContent", () => {
  it("normalizes case, whitespace, and trailing punctuation for duplicate detection", () => {
    expect(normalizeContextContent("  Use   PNPM。\n")) .toBe("use pnpm");
  });

  it("produces the same signature for normalized-equivalent content", () => {
    expect(createContentSignature("Use pnpm.")).toBe(createContentSignature(" use  PNPM "));
  });
});
