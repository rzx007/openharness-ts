import { describe, expect, it, vi } from "vitest";
import { abortableDelay } from "./retry.js";

describe("abortableDelay", () => {
  it("keeps its timer referenced so a standalone process waits for retry", async () => {
    const realSetTimeout = globalThis.setTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: TimerHandler, timeout?: number, ...args: any[]) => {
        timer = realSetTimeout(handler, timeout, ...args);
        return timer;
      }) as typeof setTimeout);
    const controller = new AbortController();
    const interrupted = new Error("stop test delay");
    let observedRejection: Promise<unknown> | undefined;

    try {
      const delay = abortableDelay(10_000, controller.signal);
      observedRejection = delay.catch((error) => error);

      expect(timer?.hasRef()).toBe(true);
      controller.abort(interrupted);
      expect(await observedRejection).toBe(interrupted);
    } finally {
      controller.abort(interrupted);
      await observedRejection;
      setTimeoutSpy.mockRestore();
    }
  });
});
