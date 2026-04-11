import { describe, it, expect } from "vitest";
import { todoWriteTool } from "./todo-write.js";
import { sleepTool } from "./sleep.js";
import { briefTool } from "./brief.js";
import { configTool } from "./config.js";
import { toolSearchTool } from "./tool-search.js";
import { askUserTool } from "./ask-user.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("todoWriteTool", () => {
  it("appends an unchecked item to TODO.md", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-test-"));
    try {
      await todoWriteTool.execute!({ item: "Fix bug" }, { cwd: dir });
      const content = await fs.readFile(path.join(dir, "TODO.md"), "utf-8");
      expect(content).toContain("- [ ] Fix bug");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("appends a checked item", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-test-"));
    try {
      await todoWriteTool.execute!({ item: "Done task", checked: true }, { cwd: dir });
      const content = await fs.readFile(path.join(dir, "TODO.md"), "utf-8");
      expect(content).toContain("- [x] Done task");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("uses custom path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-test-"));
    try {
      await todoWriteTool.execute!({ item: "Custom", path: "TASKS.md" }, { cwd: dir });
      const content = await fs.readFile(path.join(dir, "TASKS.md"), "utf-8");
      expect(content).toContain("- [ ] Custom");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

describe("sleepTool", () => {
  it("sleeps and returns message", async () => {
    const start = Date.now();
    const result = await sleepTool.execute!({ seconds: 0.01 }, { cwd: process.cwd() });
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as any).text).toContain("Slept");
  });

  it("clamps to 30 seconds max", async () => {
    const result = await sleepTool.execute!({ seconds: 0.01 }, { cwd: process.cwd() });
    expect((result.content[0] as any).text).toContain("0.01");
  });
});

describe("briefTool", () => {
  it("returns text unchanged when short enough", async () => {
    const result = await briefTool.execute!({ text: "Hello world" }, { cwd: process.cwd() });
    expect((result.content[0] as any).text).toBe("Hello world");
  });

  it("truncates long text", async () => {
    const longText = "a".repeat(300);
    const result = await briefTool.execute!({ text: longText, maxChars: 100 }, { cwd: process.cwd() });
    const text = (result.content[0] as any).text;
    expect(text.length).toBeLessThanOrEqual(103);
    expect(text.endsWith("...")).toBe(true);
  });
});

describe("configTool", () => {
  it("shows config", async () => {
    const result = await configTool.execute!({ action: "show" }, { cwd: process.cwd() });
    const text = (result.content[0] as any).text;
    expect(text).toContain("model");
  });
});

describe("toolSearchTool", () => {
  it("finds matching tools", async () => {
    const result = await toolSearchTool.execute!({ query: "bash" }, { cwd: process.cwd() });
    const text = (result.content[0] as any).text;
    expect(text).toContain("Bash");
  });

  it("returns no matches message", async () => {
    const result = await toolSearchTool.execute!({ query: "zzznonexistent" }, { cwd: process.cwd() });
    const text = (result.content[0] as any).text;
    expect(text).toContain("no matches");
  });
});

describe("askUserTool", () => {
  it("returns error when no prompt function available", async () => {
    const result = await askUserTool.execute!({ question: "What?" }, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
  });

  it("calls askUserPrompt when available", async () => {
    const result = await askUserTool.execute!(
      { question: "Name?" },
      { cwd: process.cwd(), askUserPrompt: async () => "Alice" } as any
    );
    expect((result.content[0] as any).text).toBe("Alice");
  });
});
