import { test, expect } from "bun:test";
import { computeScore } from "./frecency";

// ─── Unit tests for score formula ────────────────────────────────────────────

test("computeScore returns 0 for empty timestamp list", () => {
  expect(computeScore([])).toBe(0);
});

test("computeScore gives higher score for recent usage", () => {
  const now = Date.now();
  const recent = now - 1000;
  const old = now - 14 * 24 * 60 * 60 * 1000;
  const scoreRecent = computeScore([recent]);
  const scoreOld = computeScore([old]);
  expect(scoreRecent).toBeGreaterThan(scoreOld);
});

test("computeScore accumulates over multiple usages", () => {
  const now = Date.now();
  const scoreOne = computeScore([now]);
  const scoreThree = computeScore([now, now, now]);
  expect(scoreThree).toBeGreaterThan(scoreOne);
});
