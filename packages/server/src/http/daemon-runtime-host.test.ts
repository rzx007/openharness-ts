import { describe, expect, it, vi } from "vitest";

import { DaemonRuntimeHostPort } from "./daemon-runtime-host.js";

function scope() {
  return {
    sessionId: "s1",
    runId: "run1",
    inputId: "input1",
    cwd: "/repo",
    traceId: "trace1",
    signal: new AbortController().signal,
  };
}

describe("DaemonRuntimeHostPort", () => {
  it("delegates host events and permission decisions", async () => {
    const emitEvent = vi.fn();
    const emitStreamEvent = vi.fn();
    const requestPermission = vi.fn(async () => ({ status: "approved" as const }));
    const host = new DaemonRuntimeHostPort({
      scope: scope(),
      emitEvent,
      emitStreamEvent,
      requestPermission,
    });

    await host.emitEvent({ type: "runtime.event", payload: { ok: true } });
    await host.emitStreamEvent({ type: "text_delta", delta: "hi" });
    const decision = await host.requestPermission({
      toolName: "Write",
      reason: "needs write",
      input: { file_path: "a.txt" },
    });

    expect(emitEvent).toHaveBeenCalledWith({ type: "runtime.event", payload: { ok: true } });
    expect(emitStreamEvent).toHaveBeenCalledWith({ type: "text_delta", delta: "hi" });
    expect(requestPermission).toHaveBeenCalledWith({
      toolName: "Write",
      reason: "needs write",
      input: { file_path: "a.txt" },
    });
    expect(decision.status).toBe("approved");
  });

});
