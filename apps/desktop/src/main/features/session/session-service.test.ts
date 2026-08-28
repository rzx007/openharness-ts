import { describe, expect, it, vi } from "vitest"

import type { DesktopModel } from "../../../shared/session-types"
import {
  resolveBootstrapRuntimeSelection,
  resolveDesktopRuntimeSnapshot,
} from "./runtime-selection"
import { DesktopSessionService } from "./session-service"

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
    expect(resolveBootstrapRuntimeSelection(models, "gpt-5.3-codex-spark", "gemini")).toEqual({
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

describe("resolveDesktopRuntimeSnapshot", () => {
  it("returns normalized models and patch flags from the same runtime resolution", () => {
    expect(
      resolveDesktopRuntimeSnapshot(models, {
        model: "gpt-5.3-codex-spark",
        provider: "gemini",
      })
    ).toMatchObject({
      defaultModel: "gemini-2.5-pro",
      defaultProvider: "gemini",
      configuredModel: "gpt-5.3-codex-spark",
      configuredProvider: "gemini",
      needsModelPatch: true,
      needsProviderPatch: false,
    })
  })

  it("keeps a configured model visible when it is no longer in the loaded catalog", () => {
    const snapshot = resolveDesktopRuntimeSnapshot(models, {
      model: "legacy-model",
      provider: undefined,
    })

    expect(snapshot.defaultModel).toBe("legacy-model")
    expect(snapshot.models[0]).toMatchObject({
      id: "legacy-model",
      label: "legacy-model",
      providerName: "Configured",
    })
  })
})

describe("DesktopSessionService.sendPrompt attachments", () => {
  it("accepts an attachment-only prompt and preserves attachment order", async () => {
    const admitPrompt = vi.fn(async () => undefined)
    const service = serviceWithClient({ admitPrompt })

    await service.sendPrompt({
      id: "input-1",
      sessionId: "session-1",
      content: "",
      attachments: [
        { assetId: "att-b", intent: "auto", displayName: "b.png" },
        { assetId: "att-a", intent: "auto", displayName: "a.pdf" },
      ],
    })

    expect(admitPrompt).toHaveBeenCalledWith("session-1", {
      id: "input-1",
      content: "",
      delivery: "queue",
      attachments: [
        { assetId: "att-b", intent: "auto", displayName: "b.png" },
        { assetId: "att-a", intent: "auto", displayName: "a.pdf" },
      ],
      metadata: {
        origin: {
          client: "desktop",
          component: "composer",
          action: "append_prompt",
        },
      },
    })
  })

  it("rejects a prompt when both text and attachments are empty", async () => {
    const admitPrompt = vi.fn(async () => undefined)
    const service = serviceWithClient({ admitPrompt })

    await expect(
      service.sendPrompt({
        id: "input-empty",
        sessionId: "session-1",
        content: "   ",
        attachments: [],
      })
    ).rejects.toThrow("消息内容和附件不能同时为空")
    expect(admitPrompt).not.toHaveBeenCalled()
  })

  it("preserves ordered refs when editing an attachment-only prompt", async () => {
    const editLatestPrompt = vi.fn(async () => undefined)
    const service = serviceWithClient({ admitPrompt: vi.fn(), editLatestPrompt })

    await service.editLatestPrompt({
      id: "edit-1",
      sessionId: "session-1",
      sourceMessageId: "message-1",
      content: "",
      attachments: [
        { assetId: "asset-b", intent: "auto", displayName: "b.png" },
        { assetId: "asset-a", intent: "auto", displayName: "a.pdf" },
      ],
    })

    expect(editLatestPrompt).toHaveBeenCalledWith("session-1", {
      id: "edit-1",
      sourceMessageId: "message-1",
      content: "",
      attachments: [
        { assetId: "asset-b", intent: "auto", displayName: "b.png" },
        { assetId: "asset-a", intent: "auto", displayName: "a.pdf" },
      ],
      metadata: {
        origin: {
          client: "desktop",
          component: "latest-message-editor",
          action: "edit_latest_prompt",
        },
      },
    })
  })
})

function serviceWithClient(client: {
  admitPrompt: ReturnType<typeof vi.fn>
  editLatestPrompt?: ReturnType<typeof vi.fn>
}): DesktopSessionService {
  const service = new DesktopSessionService()
  ;(
    service as unknown as {
      clientPromise: Promise<typeof client>
    }
  ).clientPromise = Promise.resolve(client)
  return service
}
