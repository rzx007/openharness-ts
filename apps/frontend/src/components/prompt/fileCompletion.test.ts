import { test, expect } from "bun:test";
import { detectAtToken, buildAtItems } from "./fileCompletion";

// ─── detectAtToken ────────────────────────────────────────────────────────────

test("detectAtToken returns null when no @ present", () => {
  expect(detectAtToken("hello world")).toBeNull();
});

test("detectAtToken returns null when @ is followed by space", () => {
  expect(detectAtToken("hello @ world")).toBeNull();
});

test("detectAtToken detects @ at start of text", () => {
  const result = detectAtToken("@src/foo");
  expect(result).not.toBeNull();
  expect(result!.token).toBe("src/foo");
  expect(result!.atStart).toBe(0);
});

test("detectAtToken detects @ after space", () => {
  const result = detectAtToken("fix the @src/bar issue");
  expect(result).not.toBeNull();
  expect(result!.token).toBe("src/bar");
  expect(result!.atStart).toBe(8);
});

test("detectAtToken detects empty token (@)", () => {
  const result = detectAtToken("hello @");
  expect(result).not.toBeNull();
  expect(result!.token).toBe("");
});

// ─── buildAtItems ─────────────────────────────────────────────────────────────

test("buildAtItems filters by token prefix", () => {
  const files = ["src/foo.ts", "src/bar.ts", "lib/baz.ts"];
  const items = buildAtItems(files, "src/");
  expect(items.map((i) => i.id)).toContain("src/foo.ts");
  expect(items.map((i) => i.id)).toContain("src/bar.ts");
  expect(items.map((i) => i.id)).not.toContain("lib/baz.ts");
});

test("buildAtItems returns at most 10 items", () => {
  const files = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`);
  const items = buildAtItems(files, "src/");
  expect(items.length).toBeLessThanOrEqual(10);
});

test("buildAtItems empty token returns first 10 files", () => {
  const files = Array.from({ length: 30 }, (_, i) => `file${i}.ts`);
  const items = buildAtItems(files, "");
  expect(items.length).toBe(10);
});
