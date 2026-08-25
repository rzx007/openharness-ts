import { describe, expect, it } from "vitest"

import type { DesktopModel } from "../../../shared/session-types"
import { resolveBootstrapRuntimeSelection } from "./runtime-selection"

const models: DesktopModel[] = [
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    provider: "Codex Subscription",
    providerName: "codex",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "Gemini",
    providerName: "gemini",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    provider: "OpenAI",
    providerName: "openai",
  },
]

describe("resolveBootstrapRuntimeSelection", () => {
  it("prefers the configured provider and switches to one of its models when the saved model belongs elsewhere", () => {
    expect(
      resolveBootstrapRuntimeSelection(models, "gpt-5.3-codex-spark", "gemini")
    ).toEqual({
      model: "gemini-2.5-pro",
      provider: "gemini",
    })
  })

  it("keeps the saved provider/model pair when they still match", () => {
    expect(resolveBootstrapRuntimeSelection(models, "gemini-2.5-pro", "gemini")).toEqual({
      model: "gemini-2.5-pro",
      provider: "gemini",
    })
  })

  it("derives the provider from the saved model when no provider is configured", () => {
    expect(resolveBootstrapRuntimeSelection(models, "gpt-5.4", undefined)).toEqual({
      model: "gpt-5.4",
      provider: "openai",
    })
  })

  it("falls back to the first available model when there is no saved runtime selection", () => {
    expect(resolveBootstrapRuntimeSelection(models, undefined, undefined)).toEqual({
      model: "gpt-5.3-codex-spark",
      provider: "codex",
    })
  })
})
