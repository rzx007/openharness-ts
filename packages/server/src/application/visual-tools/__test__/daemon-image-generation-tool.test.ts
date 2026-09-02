import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonImageGenerationTool } from "../daemon-image-generation-tool.js";

afterEach(() => vi.unstubAllGlobals());

describe("daemon ImageGeneration tool", () => {
  it("uses the current ToolContext settings without a special Settings field", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://images.example/v1/images/generations");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("image-model");
      return new Response(JSON.stringify({ data: [] }));
    }));

    await createDaemonImageGenerationTool().execute(
      { prompt: "a quiet terminal", model: "image-model" },
      {
        cwd: "C:/work",
        settings: {
          model: "chat-model",
          apiFormat: "openai",
          apiKey: "test-key",
          baseUrl: "https://images.example",
          maxTurns: 1,
          permission: { mode: "default" },
        },
      } as any,
    );

    expect(fetch).toHaveBeenCalledOnce();
  });
});
