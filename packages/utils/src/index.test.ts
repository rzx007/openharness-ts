import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  ensureAbsolute,
  truncateWithEllipsis,
  debounce,
  sleep,
  tryParseJson,
  formatBytes,
  formatDuration,
  groupBy,
} from "../src/index.js";

describe("ensureAbsolute", () => {
  it("converts relative path to absolute", () => {
    const result = ensureAbsolute("foo/bar.txt", "/home/user");
    expect(result).toBe(resolve("/home/user", "foo/bar.txt"));
  });

  it("returns absolute path unchanged when already absolute on same base", () => {
    const base = process.cwd();
    const result = ensureAbsolute(resolve(base, "abs.txt"), base);
    expect(result).toBe(resolve(base, "abs.txt"));
  });

  it("uses process.cwd() when base not provided", () => {
    const result = ensureAbsolute("file.txt");
    expect(result).toContain("file.txt");
  });
});

describe("truncateWithEllipsis", () => {
  it("returns text as-is when within limit", () => {
    expect(truncateWithEllipsis("hello", 10)).toBe("hello");
  });

  it("truncates and adds ellipsis", () => {
    expect(truncateWithEllipsis("hello world", 8)).toBe("hello...");
  });

  it("handles exact length", () => {
    expect(truncateWithEllipsis("hello", 5)).toBe("hello");
  });
});

describe("debounce", () => {
  it("delays function execution", async () => {
    let count = 0;
    const fn = debounce(() => { count++; }, 50);
    fn();
    fn();
    fn();
    expect(count).toBe(0);
    await sleep(100);
    expect(count).toBe(1);
  });
});

describe("sleep", () => {
  it("resolves after delay", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe("tryParseJson", () => {
  it("parses valid JSON", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for invalid JSON", () => {
    expect(tryParseJson("not json")).toBeNull();
  });

  it("parses arrays", () => {
    expect(tryParseJson("[1,2,3]")).toEqual([1, 2, 3]);
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500.0B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1048576)).toBe("1.0MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1073741824)).toBe("1.0GB");
  });

  it("formats zero", () => {
    expect(formatBytes(0)).toBe("0.0B");
  });
});

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(1500)).toBe("1.5s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(125000)).toBe("2m5s");
  });

  it("formats exact minute", () => {
    expect(formatDuration(60000)).toBe("1m0s");
  });
});

describe("groupBy", () => {
  it("groups items by key", () => {
    const items = [
      { type: "a", val: 1 },
      { type: "b", val: 2 },
      { type: "a", val: 3 },
    ];
    const result = groupBy(items, (item) => item.type);
    expect(result.get("a")).toEqual([
      { type: "a", val: 1 },
      { type: "a", val: 3 },
    ]);
    expect(result.get("b")).toEqual([{ type: "b", val: 2 }]);
  });

  it("returns empty map for empty array", () => {
    const result = groupBy([], () => "x");
    expect(result.size).toBe(0);
  });
});
