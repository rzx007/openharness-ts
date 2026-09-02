import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@openharness/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openharness/core")>()),
  loadSettings: vi.fn(async () => {
    throw new Error("process-global settings must not be loaded");
  }),
}));

import { imageGenerationTool } from "../image-generation.js";

afterEach(() => vi.unstubAllGlobals());

describe("ImageGeneration", () => {
  it("uses the current ToolContext settings instead of process-global settings", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://images.example/v1/images/generations");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("image-model");
      return new Response(JSON.stringify({ data: [] }));
    }));

    await imageGenerationTool.execute(
      { prompt: "a quiet terminal", model: "image-model" },
      {
        cwd: "C:/work",
        settings: {
          model: "chat-model",
          apiFormat: "openai",
          apiKey: "test-key",
          baseUrl: "https://chat.example",
          imageGenerationBaseUrl: "https://images.example",
          maxTurns: 1,
          permission: { mode: "default" },
        },
      } as any,
    );

    expect(fetch).toHaveBeenCalledOnce();
  });
});
