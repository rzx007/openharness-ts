import { describe, expect, it } from "vitest";

import {
  modelInputCapabilities,
  resolveEffectiveImageSupport,
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
