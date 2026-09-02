import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonImageGenerationTool } from "../daemon-image-generation-tool.js";

afterEach(() => vi.unstubAllGlobals());

const settings = {
  model: "chat-model",
  apiFormat: "openai" as const,
  apiKey: "test-key",
  baseUrl: "https://images.example",
  maxTurns: 1,
  permission: { mode: "default" as const },
};

function captureFetch() {
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      authorization: String(init?.headers?.Authorization ?? init?.headers?.authorization ?? ""),
    });
    return new Response(JSON.stringify({ data: [] }));
  }));
  return requests;
}

describe("daemon ImageGeneration tool", () => {
  it("sends Agnes text-to-image fields and uses ToolContext credentials", async () => {
    const requests = captureFetch();

    await createDaemonImageGenerationTool().execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", settings } as any,
    );

    expect(requests).toEqual([{
      url: "https://images.example/v1/images/generations",
      authorization: "Bearer test-key",
      body: {
        model: "agnes-image-2.5-flash",
        prompt: "a quiet terminal",
        size: "1K",
        ratio: "1:1",
        return_base64: true,
      },
    }]);
  });

  it("does not duplicate /v1 when baseUrl already includes it", async () => {
    const requests = captureFetch();

    await createDaemonImageGenerationTool().execute(
      { prompt: "a quiet terminal", size: "2K", ratio: "16:9" },
      {
        cwd: "C:/work",
        settings: { ...settings, baseUrl: "https://api.agnes-ai.cn/v1" },
      } as any,
    );

    expect(requests[0]?.url).toBe("https://api.agnes-ai.cn/v1/images/generations");
    expect(requests[0]?.body).toMatchObject({ size: "2K", ratio: "16:9", return_base64: true });
    expect(requests[0]?.body).not.toHaveProperty("response_format");
    expect(requests[0]?.body).not.toHaveProperty("quality");
    expect(requests[0]?.body).not.toHaveProperty("n");
  });

  it("puts reference images and img2img output format under extra_body", async () => {
    const requests = captureFetch();

    await createDaemonImageGenerationTool().execute(
      {
        prompt: "make it cyberpunk",
        images: ["https://example.com/input.png", "data:image/png;base64,abcd"],
      },
      { cwd: "C:/work", settings } as any,
    );

    expect(requests[0]?.body).toEqual({
      model: "agnes-image-2.5-flash",
      prompt: "make it cyberpunk",
      size: "1K",
      ratio: "1:1",
      extra_body: {
        image: ["https://example.com/input.png", "data:image/png;base64,abcd"],
        response_format: "b64_json",
      },
    });
    expect(requests[0]?.body).not.toHaveProperty("return_base64");
  });

  it("rejects a missing API key without calling the provider", async () => {
    const requests = captureFetch();

    const result = await createDaemonImageGenerationTool().execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", settings: { ...settings, apiKey: "" } } as any,
    );

    expect(requests).toEqual([]);
    expect(result).toMatchObject({ isError: true, failureKind: "policy" });
  });
});
