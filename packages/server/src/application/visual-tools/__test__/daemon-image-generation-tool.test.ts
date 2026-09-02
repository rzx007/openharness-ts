import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonImageGenerationTool } from "../daemon-image-generation-tool.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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
  it("uses dedicated Agnes environment configuration instead of chat settings", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubEnv("AGNES_IMAGE_BASE_URL", "https://agnes-images.example");
    vi.stubEnv("AGNES_IMAGE_MODEL", "agnes-image-test-model");
    const requests = captureFetch();

    await createDaemonImageGenerationTool().execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", settings } as any,
    );

    expect(requests).toEqual([{
      url: "https://agnes-images.example/v1/images/generations",
      authorization: "Bearer agnes-test-key",
      body: {
        model: "agnes-image-test-model",
        prompt: "a quiet terminal",
        size: "1K",
        ratio: "1:1",
        return_base64: true,
      },
    }]);
  });

  it("does not duplicate /v1 when baseUrl already includes it", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubEnv("AGNES_IMAGE_BASE_URL", "https://api.agnes-ai.cn/v1");
    const requests = captureFetch();

    await createDaemonImageGenerationTool().execute(
      { prompt: "a quiet terminal", size: "2K", ratio: "16:9" },
      { cwd: "C:/work", settings } as any,
    );

    expect(requests[0]?.url).toBe("https://api.agnes-ai.cn/v1/images/generations");
    expect(requests[0]?.body).toMatchObject({ size: "2K", ratio: "16:9", return_base64: true });
    expect(requests[0]?.body).not.toHaveProperty("response_format");
    expect(requests[0]?.body).not.toHaveProperty("quality");
    expect(requests[0]?.body).not.toHaveProperty("n");
  });

  it("puts reference images and img2img output format under extra_body", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
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
    vi.stubEnv("AGNES_API_KEY", "");
    const requests = captureFetch();

    const result = await createDaemonImageGenerationTool().execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", settings } as any,
    );

    expect(requests).toEqual([]);
    expect(result).toMatchObject({ isError: true, failureKind: "policy" });
  });

  it.each([401, 403])("identifies HTTP %s as rejected Agnes credentials", async (status) => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "credential rejected" } }),
      { status },
    )));

    const result = await createDaemonImageGenerationTool().execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", settings } as any,
    );

    expect(result).toMatchObject({ isError: true, failureKind: "provider" });
    expect(result.content[0]?.text).toContain(`credentials rejected (HTTP ${status})`);
  });

  it("reports rate limiting and the provider retry delay", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "4K tier allows 1 request per minute" } }),
      { status: 429, headers: { "Retry-After": "60" } },
    )));

    const result = await createDaemonImageGenerationTool().execute(
      { prompt: "a quiet terminal", size: "4K" },
      { cwd: "C:/work", settings } as any,
    );

    expect(result).toMatchObject({ isError: true, failureKind: "provider" });
    expect(result.content[0]?.text).toContain("rate limited (HTTP 429)");
    expect(result.content[0]?.text).toContain("Retry after 60 seconds");
  });

  it("returns a redacted fetch failure instead of hiding its cause", async () => {
    vi.stubEnv("AGNES_API_KEY", "agnes-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("TLS failure while using agnes-test-key");
    }));

    const result = await createDaemonImageGenerationTool().execute(
      { prompt: "a quiet terminal" },
      { cwd: "C:/work", settings } as any,
    );

    expect(result).toMatchObject({ isError: true, failureKind: "provider" });
    expect(result.content[0]?.text).toContain("Error: TLS failure while using [redacted]");
    expect(result.content[0]?.text).not.toContain("agnes-test-key");
  });
});
