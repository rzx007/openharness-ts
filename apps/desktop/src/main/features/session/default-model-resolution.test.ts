import { describe, expect, it } from "vitest"

import type { DesktopModel } from "../../../shared/session-types"
import { normalizeConfiguredModelId } from "./default-model-resolution"

const deepSeekModels: DesktopModel[] = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "DeepSeek",
    providerName: "deepseek",
  },
]

describe("normalizeConfiguredModelId", () => {
  it("migrates the legacy prefixed DeepSeek model ID", () => {
    expect(
      normalizeConfiguredModelId(deepSeekModels, "deepseek/deepseek-v4-flash", "deepseek")
    ).toBe("deepseek-v4-flash")
  })

  it("does not strip provider prefixes from unrelated models", () => {
    expect(
      normalizeConfiguredModelId(deepSeekModels, "deepseek/deepseek-chat-v3.1:free", "openrouter")
    ).toBe("deepseek/deepseek-chat-v3.1:free")
  })
})
