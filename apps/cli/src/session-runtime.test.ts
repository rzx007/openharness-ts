import { describe, expect, it, vi } from "vitest";
import * as sessionRuntimeModule from "./session-runtime.js";

describe("CliSessionRuntime cancellation", () => {
  it("passes the run signal to QueryEngine.submitMessage", async () => {
    const Runtime = (sessionRuntimeModule as unknown as {
      CliSessionRuntime?: new (...args: any[]) => {
        runPrompt(input: any, hooks: any): Promise<unknown>;
      };
    }).CliSessionRuntime;
    expect(Runtime).toBeTypeOf("function");
    if (!Runtime) return;

    const submitMessage = vi.fn(async function* () {});
    const queryEngine = {
      submitMessage,
      setModel: vi.fn(),
      setRuntimeEventSink: vi.fn(),
    };
    const runtime = new Runtime(
      { queryEngine },
      { getConnections: () => [] },
      process.cwd(),
      () => ({}),
      vi.fn(),
    );
    const controller = new AbortController();

    await runtime.runPrompt(
      {
        session: { model: undefined },
        input: { content: "hello" },
        signal: controller.signal,
      },
      {
        askPermission: vi.fn(),
        onEvent: vi.fn(),
        onStreamEvent: vi.fn(),
      },
    );

    expect(submitMessage).toHaveBeenCalledWith(
      "hello",
      { signal: controller.signal },
    );
  });
});
