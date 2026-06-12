import { test, expect } from "bun:test";
import { fuzzyFilter } from "./fuzzy";

const items = ["/theme", "/permissions", "/plan", "/help"];

test("empty query keeps order", () => {
  expect(fuzzyFilter(items, "", (s) => s)).toEqual(items);
});

test("subsequence match, prefix first", () => {
  expect(fuzzyFilter(items, "/p", (s) => s)).toEqual(["/permissions", "/plan"]);
  expect(fuzzyFilter(items, "pln", (s) => s)).toEqual(["/plan"]);
});

test("no match returns empty", () => {
  expect(fuzzyFilter(items, "zzz", (s) => s)).toEqual([]);
});
