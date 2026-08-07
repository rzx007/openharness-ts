import { describe, expect, it, vi } from "vitest";
import * as sessionRuntimeModule from "./session-runtime.js";

describe("CliSessionRuntime cancellation", () => {
  it("passes the run signal to QueryEngine.submitMessage", async () => {
    const Runtime = (sessionRuntimeModule as unknown as {
      CliSessionRuntime?: new (...args: any[]) => {
        runPrompt(input: any, host: any): Promise<unknown>;
      };
    }).CliSessionRuntime;
    expect(Runtime).toBeTypeOf("function");
    if (!Runtime) return;

    const submitMessage = vi.fn(async function* () {});
    const queryEngine = {
      submitMessage,
      setModel: vi.fn(),
    };
    const runtime = new Runtime(
      { queryEngine },
      { getConnections: () => [] },
      process.cwd(),
      () => ({}),
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
        requestPermission: vi.fn(),
        emitEvent: vi.fn(),
        emitStreamEvent: vi.fn(),
      },
    );

    expect(submitMessage).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        signal: controller.signal,
        pullFollowUps: expect.any(Function),
        runtimeHost: expect.objectContaining({
          requestPermission: expect.any(Function),
          emitEvent: expect.any(Function),
        }),
      }),
    );
  });

  it("drains steered inputs when wakeCount increases at turn boundaries", async () => {
    const Runtime = (sessionRuntimeModule as unknown as {
      CliSessionRuntime?: new (...args: any[]) => {
        runPrompt(input: any, host: any): Promise<unknown>;
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
    };
    const runtime = new Runtime(
      { queryEngine },
      { getConnections: () => [] },
      process.cwd(),
      () => ({}),
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
        requestPermission: vi.fn(),
        emitEvent: vi.fn(),
        emitStreamEvent: vi.fn(),
      },
    );

    expect(pullFollowUps?.()).toEqual([]);
    wake = 1;
    expect(pullFollowUps?.()).toEqual(["course correct"]);
    expect(drainSteeredInputs).toHaveBeenCalledTimes(1);
    expect(pullFollowUps?.()).toEqual([]);
  });
});
