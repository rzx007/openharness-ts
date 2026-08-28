import { describe, expect, it } from "vitest";

import {
  modelInputCapabilities,
  resolveEffectiveImageSupport,
  resolveRuntimeAttachmentCapabilities,
} from "../attachment-capabilities.js";

describe("attachment input capabilities", () => {
  it("maps explicit model input modalities without guessing from the model name", () => {
    expect(modelInputCapabilities({ modalities: { input: ["text", "image"] } }))
      .toEqual({ image: "native" });
    expect(modelInputCapabilities({ modalities: { input: ["text"] } }))
      .toEqual({ image: "unsupported" });
    expect(modelInputCapabilities({ id: "gpt-4o" })).toEqual({ image: "unknown" });
  });

  it("requires both the model and adapter to declare native image input", () => {
    expect(resolveEffectiveImageSupport(
      { image: "native" },
      { image: "native", imageMediaTypes: ["image/png"] },
    )).toBe("native");
    expect(resolveEffectiveImageSupport(
      { image: "native" },
      { image: "unknown", imageMediaTypes: [] },
    )).toBe("unknown");
    expect(resolveEffectiveImageSupport(
      { image: "unknown" },
      { image: "native", imageMediaTypes: ["image/png"] },
    )).toBe("unknown");
    expect(resolveEffectiveImageSupport(
      { image: "unsupported" },
      { image: "native", imageMediaTypes: ["image/png"] },
    )).toBe("unsupported");
  });
});

describe("resolveRuntimeAttachmentCapabilities", () => {
  it("uses an explicit custom model capability and openai adapter", () => {
    expect(resolveRuntimeAttachmentCapabilities({
      runtime: { model: "vision-local", provider: "my-provider" },
      settings: {
        model: "vision-local",
        provider: "my-provider",
        apiFormat: "openai",
        maxTurns: 10,
        permission: { mode: "default" },
        customProviders: [{
          id: "my-provider",
          displayName: "Mine",
          baseUrl: "http://localhost/v1",
          apiFormat: "openai",
          models: [{ id: "vision-local", displayName: "Vision", imageInputSupport: "native" }],
        }],
      } as any,
      modelProviders: [{
        name: "my-provider",
        displayName: "Mine",
        models: [{ id: "vision-local", label: "Vision", provider: "Mine", providerName: "my-provider", inputCapabilities: { image: "native" } }],
      }],
    })).toMatchObject({
      modelCapabilities: { image: "native" },
      providerCapabilities: { image: "native" },
    });
  });
});
