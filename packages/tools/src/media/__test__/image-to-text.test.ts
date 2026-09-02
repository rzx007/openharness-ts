import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { imageToTextTool } from "../image-to-text.js";

afterEach(() => vi.unstubAllGlobals());

describe("ImageToText", () => {
  it("uses context settings to send a local image to an OpenAI-compatible endpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-image-to-text-"));
    const imagePath = join(dir, "invoice.png");
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("vision-main");
      expect(body.messages[0].content).toEqual([
        expect.objectContaining({ type: "image_url" }),
        { type: "text", text: "Extract every visible word." },
      ]);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "invoice 123" } }],
      }), { status: 200 });
    }));

    try {
      const result = await imageToTextTool.execute(
        { image_path: imagePath, prompt: "Extract every visible word." },
        { cwd: dir, settings: settings("vision-main", "openai") } as any,
      );
      expect(result.content).toEqual([{ type: "text", text: "invoice 123" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends an HTTP image URL using the Anthropic message format", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://vision.example/v1/messages");
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content[0]).toEqual({
        type: "image",
        source: { type: "url", url: "https://images.example/cat.png" },
      });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "a cat" }] }));
    }));

    const result = await imageToTextTool.execute(
      { image_url: "https://images.example/cat.png" },
      { cwd: "C:/work", settings: settings("vision-main", "anthropic") } as any,
    );
    expect(result.content).toEqual([{ type: "text", text: "a cat" }]);
  });

  it("rejects missing, multiple, attachment, and non-http sources", async () => {
    for (const input of [
      {},
      { image_path: "a.png", image_url: "https://example.com/a.png" },
      { attachment_id: "att-1" },
      { image_url: "file:///secret.png" },
    ]) {
      await expect(imageToTextTool.execute(input, {
        cwd: "C:/work",
        settings: settings("vision-main", "openai"),
      } as any)).resolves.toMatchObject({ isError: true, failureKind: "command" });
    }
  });

  it("requires runtime settings and redacts provider failures", async () => {
    await expect(imageToTextTool.execute(
      { image_url: "https://images.example/cat.png" },
      { cwd: "C:/work" } as any,
    )).resolves.toMatchObject({ isError: true, failureKind: "policy" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `secret-key:${"x".repeat(5000)}`,
      { status: 500 },
    )));
    const result = await imageToTextTool.execute(
      { image_url: "https://images.example/cat.png" },
      { cwd: "C:/work", settings: { ...settings("vision-main", "openai"), apiKey: "secret-key" } } as any,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(result).toMatchObject({ isError: true, failureKind: "provider" });
    expect(text).not.toContain("secret-key");
    expect(text.length).toBeLessThan(1200);
  });
});

function settings(model: string, apiFormat: "openai" | "anthropic") {
  return {
    model,
    apiFormat,
    apiKey: "test-key",
    baseUrl: "https://vision.example",
    maxTurns: 1,
    permission: { mode: "default" as const },
  };
}
