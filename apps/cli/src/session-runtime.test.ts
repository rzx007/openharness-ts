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
        wakeCount: () => 0,
        drainSteeredInputs: () => [],
      },
      {
        askPermission: vi.fn(),
        onEvent: vi.fn(),
        onStreamEvent: vi.fn(),
      },
    );

    expect(submitMessage).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ signal: controller.signal, pullFollowUps: expect.any(Function) }),
    );
  });

  it("drains steered inputs when wakeCount increases at turn boundaries", async () => {
    const Runtime = (sessionRuntimeModule as unknown as {
      CliSessionRuntime?: new (...args: any[]) => {
        runPrompt(input: any, hooks: any): Promise<unknown>;
      };
    }).CliSessionRuntime;
    expect(Runtime).toBeTypeOf("function");
    if (!Runtime) return;

    let pullFollowUps: (() => string[]) | undefined;
    const submitMessage = vi.fn(async function* (_content: string, options: { pullFollowUps?: () => string[] }) {
      pullFollowUps = options.pullFollowUps;
    });
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

    let wake = 0;
    const drainSteeredInputs = vi.fn(() => [{ content: "course correct" }]);
    await runtime.runPrompt(
      {
        session: { model: undefined },
        input: { content: "hello" },
        signal: new AbortController().signal,
        wakeCount: () => wake,
        drainSteeredInputs,
      },
      {
        askPermission: vi.fn(),
        onEvent: vi.fn(),
        onStreamEvent: vi.fn(),
      },
    );

    expect(pullFollowUps?.()).toEqual([]);
    wake = 1;
    expect(pullFollowUps?.()).toEqual(["course correct"]);
    expect(drainSteeredInputs).toHaveBeenCalledTimes(1);
    expect(pullFollowUps?.()).toEqual([]);
  });
});
