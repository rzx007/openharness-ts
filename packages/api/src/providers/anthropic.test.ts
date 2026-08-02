import { describe, expect, it, vi } from "vitest";
import { AnthropicClient } from "./anthropic.js";

describe("AnthropicClient cancellation", () => {
  it("passes abortSignal to the Anthropic request", async () => {
    const controller = new AbortController();
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: async () => ({
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      }),
    }));
    const client = new AnthropicClient({ apiKey: "test", baseURL: undefined } as any);
    (client as any).client = { messages: { stream } };

    for await (const _ of client.streamMessage({
      model: "claude-test",
      messages: [{ type: "user", content: "hello" }],
      abortSignal: controller.signal,
    })) {}

    expect(stream).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("aborts retry backoff without starting another request", async () => {
    vi.useFakeTimers();
    let run: Promise<void> | undefined;
    try {
      const retryable = Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { get: () => "30" },
      });
      const stream = vi.fn(() => {
        throw retryable;
      });
      const client = new AnthropicClient({ apiKey: "test", baseURL: undefined } as any);
      (client as any).client = { messages: { stream } };
      const controller = new AbortController();
      const interrupted = new Error("retry interrupted");
      let rejection: unknown;

      run = (async () => {
        for await (const _ of client.streamMessage({
          model: "claude-test",
          messages: [{ type: "user", content: "hello" }],
          abortSignal: controller.signal,
        })) {}
      })();
      void run.catch((error) => {
        rejection = error;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stream).toHaveBeenCalledTimes(1);

      controller.abort(interrupted);
      await vi.advanceTimersByTimeAsync(0);

      expect(rejection).toBe(interrupted);
      expect(stream).toHaveBeenCalledTimes(1);
    } finally {
      await vi.runAllTimersAsync();
      await run?.catch(() => {});
      vi.useRealTimers();
    }
  });
});
