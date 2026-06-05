import { describe, it, expect } from "vitest";
import { bashTool } from "./bash.js";

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

  it("truncates large output at ~12000 chars", async () => {
    // Print 20000 'a' characters.
    const result = await bashTool.execute!(
      {
        command:
          "for i in $(seq 1 20000); do printf a; done",
        timeout: 30_000,
      },
      { cwd: process.cwd() }
    );
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("...[truncated]...");
    // Output body is capped near the 12000 char limit.
    expect(text.length).toBeLessThan(13000);
  }, 30_000);
});
