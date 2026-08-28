import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("AnthropicClient native image input", () => {
  it("sends text and ordered images as Anthropic base64 blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-anthropic-image-"));
    try {
      const png = join(dir, "first.png");
      const webp = join(dir, "second.webp");
      await writeFile(png, Buffer.from([1, 2, 3]));
      await writeFile(webp, Buffer.from([4, 5]));
      const stream = vi.fn(() => ({
        async *[Symbol.asyncIterator]() {},
        finalMessage: async () => ({
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: "end_turn",
        }),
      }));
      const client = new AnthropicClient({ apiKey: "test" } as any);
      (client as any).client = { messages: { stream } };

      for await (const _ of client.streamMessage({
        model: "claude-test",
        messages: [{
          type: "user",
          content: [
            { type: "text", text: "compare" },
            { type: "image", source: { type: "file", mediaType: "image/png", path: png } },
            { type: "image", source: { type: "file", mediaType: "image/webp", path: webp } },
          ],
        }],
      })) {}

      expect(stream).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "compare" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") } },
              { type: "image", source: { type: "base64", media_type: "image/webp", data: Buffer.from([4, 5]).toString("base64") } },
            ],
          }],
        }),
        expect.any(Object),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not call Anthropic when image conversion fails", async () => {
    const stream = vi.fn();
    const client = new AnthropicClient({ apiKey: "test" } as any);
    (client as any).client = { messages: { stream } };

    await expect(async () => {
      for await (const _ of client.streamMessage({
        model: "claude-test",
        messages: [{
          type: "user",
          content: [{
            type: "image",
            source: { type: "file", mediaType: "image/png", path: "missing-image.png" },
          }],
        }],
      })) {}
    }).rejects.toThrow();
    expect(stream).not.toHaveBeenCalled();
  });
});
