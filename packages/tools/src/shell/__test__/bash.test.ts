import { describe, it, expect } from "vitest";
import {
  bashTool,
  decodeShellChunk,
  formatOutput,
  looksLikeUtf16Le,
} from "../bash.js";

describe("bashTool", () => {
  it("captures stdout", async () => {
    const result = await bashTool.execute!(
      { command: "echo hello-bash" },
      { cwd: process.cwd() }
    );
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("hello-bash");
    expect(result.isError).toBeFalsy();
  });

  it("marks non-zero exit as error", async () => {
    const result = await bashTool.execute!(
      { command: "exit 3" },
      { cwd: process.cwd() }
    );
    expect(result.isError).toBe(true);
  });

  it("returns partial output after a timeout", async () => {
    // Emit a line immediately, then sleep well past the timeout. The tool must
    // kill the process AND surface the line that was already produced.
    const result = await bashTool.execute!(
      { command: "echo partial-marker; sleep 5", timeout: 500 },
      { cwd: process.cwd() }
    );
    const text = (result.content[0] as any).text as string;
    expect(result.isError).toBe(true);
    expect(text).toContain("timed out");
    expect(text).toContain("Partial output");
    expect(text).toContain("partial-marker");
  }, 10_000);

  it("truncates large output at ~12000 chars", () => {
    const text = formatOutput("a".repeat(20_000));

    expect(text).toContain("...[truncated]...");
    // Output body is capped near the 12000 char limit.
    expect(text.length).toBeLessThan(13000);
  });

  it("decodes UTF-16LE Windows shell errors", () => {
    const message = "Wsl/Service/CreateInstance/E_ACCESS_DENIED\r\n";
    const chunk = Buffer.from(message, "utf16le");

    expect(looksLikeUtf16Le(chunk)).toBe(true);
    expect(decodeShellChunk(chunk)).toContain("E_ACCESS_DENIED");
  });
});
