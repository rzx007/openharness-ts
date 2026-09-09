import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonImageToTextTool } from "../daemon-image-to-text-tool.js";

afterEach(() => vi.unstubAllGlobals());

describe("daemon ImageToText tool", () => {
  it("uses root-authorized local OCR for an attachment", async () => {
    const recognize = vi.fn(async () => ({
      status: "completed" as const,
      text: "invoice 123",
      representationId: "rep-1",
      processor: "light-ocr" as const,
      processorVersion: "1",
      cached: false,
      lineCount: 1,
      durationMs: 2,
    }));
    const tool = createDaemonImageToTextTool({
      authorizationSessions: { resolve: (id) => id === "child" ? "root" : undefined },
      attachmentOcr: { recognize },
    });

    const result = await tool.execute(
      { attachment_id: "att-1" },
      { cwd: "C:/work", sessionId: "child" },
    );

    expect(recognize).toHaveBeenCalledWith(expect.objectContaining({
      authorizationSessionId: "root",
      assetId: "att-1",
    }));
    expect((result.content[0] as { text: string }).text).toContain("invoice 123");
    expect(result.metadata).toMatchObject({ attachmentOcr: { assetId: "att-1" } });
  });

  it("uses context settings to send a local image to an OpenAI-compatible endpoint", async () => {
    const resolvePath = vi.fn(async () => ({
      executionPath: "/workspace/invoice.png",
      mountPurpose: "workspace" as const,
      mountMode: "rw" as const,
    }));
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
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
    const tool = createTool();

    const result = await tool.execute(
      { image_path: "invoice.png", prompt: "Extract every visible word." },
      {
        cwd: "/workspace",
        settings: settings("vision-main", "openai"),
        environment: {
          info: { kind: "wsl", networkMode: "host" },
          paths: { resolve: resolvePath },
          files: { readBytes },
        },
      } as any,
    );
    expect(resolvePath).toHaveBeenCalledWith("invoice.png", "read");
    expect(readBytes).toHaveBeenCalledWith("/workspace/invoice.png");
    expect(result.content).toEqual([{ type: "text", text: "invoice 123" }]);
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

    const result = await createTool().execute(
      { image_url: "https://images.example/cat.png" },
      { cwd: "C:/work", settings: settings("vision-main", "anthropic") } as any,
    );

    expect(result.content).toEqual([{ type: "text", text: "a cat" }]);
  });

  it("blocks image URLs when the effective environment has no network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await createTool().execute(
      { image_url: "https://images.example/cat.png" },
      {
        cwd: "/workspace",
        settings: settings("vision-main", "anthropic"),
        environment: { info: { kind: "wsl", networkMode: "none" } },
      } as any,
    );

    expect(result).toMatchObject({ isError: true, failureKind: "policy" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts an optional prompt with attachment OCR", async () => {
    const recognize = vi.fn(async () => ({
      status: "completed" as const,
      text: "invoice 123",
      representationId: "rep-1",
      processor: "light-ocr" as const,
      processorVersion: "1",
      cached: false,
      lineCount: 1,
      durationMs: 2,
    }));
    const tool = createDaemonImageToTextTool({
      authorizationSessions: { resolve: () => "root" },
      attachmentOcr: { recognize },
    });

    const result = await tool.execute(
      { attachment_id: "att-1", prompt: "Extract the visible text." },
      { cwd: "C:/work", sessionId: "child" },
    );
    expect(result).toMatchObject({
      metadata: { attachmentOcr: { assetId: "att-1" } },
    });
    expect(result.isError).not.toBe(true);
    expect(recognize).toHaveBeenCalledOnce();
  });

  it("rejects combining an attachment with another image source", async () => {
    const recognize = vi.fn();
    const tool = createDaemonImageToTextTool({
      authorizationSessions: { resolve: () => "root" },
      attachmentOcr: { recognize },
    });

    await expect(tool.execute(
      { attachment_id: "att-1", image_path: "invoice.png" },
      { cwd: "C:/work", sessionId: "child" },
    )).resolves.toMatchObject({ isError: true, failureKind: "command" });
    expect(recognize).not.toHaveBeenCalled();
  });

  it("requires runtime settings for vision and redacts provider failures", async () => {
    const tool = createTool();
    await expect(tool.execute(
      { image_url: "https://images.example/cat.png" },
      { cwd: "C:/work" } as any,
    )).resolves.toMatchObject({ isError: true, failureKind: "policy" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `secret-key:${"x".repeat(5000)}`,
      { status: 500 },
    )));
    const result = await tool.execute(
      { image_url: "https://images.example/cat.png" },
      { cwd: "C:/work", settings: { ...settings("vision-main", "openai"), apiKey: "secret-key" } } as any,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(result).toMatchObject({ isError: true, failureKind: "provider" });
    expect(text).not.toContain("secret-key");
    expect(text.length).toBeLessThan(1200);
  });
});

function createTool() {
  return createDaemonImageToTextTool({
    authorizationSessions: { resolve: () => undefined },
    attachmentOcr: { recognize: vi.fn() },
  });
}

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
