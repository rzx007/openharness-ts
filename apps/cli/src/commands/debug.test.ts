import { afterEach, describe, expect, it, vi } from "vitest";

import { printProjectionSettlements, printRunInspection } from "./debug.js";

describe("debug command formatters", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints a compact human run diagnosis", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printRunInspection({
      runId: "r1",
      run: { sessionId: "s1", inputId: "i1", status: "failed" },
      attempts: [{}], toolCalls: [{}, {}], permissions: [], childExecutions: [], events: [{}],
      warnings: [{ code: "unknown_tool_outcome", message: "may have executed" }],
    }, false);
    expect(log).toHaveBeenCalledWith("Run: r1  status=failed");
    expect(log).toHaveBeenCalledWith("- [unknown_tool_outcome] may have executed");
  });

  it("shows pending projection work without printing payloads", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printProjectionSettlements({ settlements: [{ id: "s1", status: "pending", projector: "agent", action: "retry-terminal-projection", attemptCount: 2 }], pending: 1 }, false);
    expect(log).toHaveBeenCalledWith("Projection settlements: 1  pending/retrying: 1");
  });
});
