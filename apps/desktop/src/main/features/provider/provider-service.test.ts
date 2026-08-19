import { describe, expect, it, vi } from "vitest"

vi.mock("../session/session-service", () => ({
  desktopSessionService: {},
}))

import { buildDesktopProviderSnapshot } from "./provider-service"

describe("buildDesktopProviderSnapshot", () => {
  it("merges provider, auth, settings and model state without exposing credentials", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [
        { name: "openai", displayName: "OpenAI", hasKey: true, active: true },
        { name: "anthropic", displayName: "Anthropic", hasKey: true, active: false },
        { name: "codex", displayName: "Codex Subscription", hasKey: true, active: false },
        { name: "ollama", displayName: "Ollama", hasKey: true, active: false, local: true },
      ],
      auth: {
        codex: {
          configured: true,
          state: "configured",
          source: "C:/Users/test/.codex/auth.json",
          profileLabel: "test@example.com",
        },
        storedProviders: ["openai"],
        envProviders: [{ name: "anthropic", envKey: "ANTHROPIC_API_KEY" }],
      },
      settings: { provider: "openai", model: "gpt-5.4" },
      models: [
        {
          name: "openai",
          displayName: "OpenAI",
          models: [{ id: "gpt-5.4", label: "GPT-5.4", provider: "OpenAI", providerName: "openai" }],
        },
      ],
    })

    expect(snapshot.activeProvider).toBe("openai")
    expect(snapshot.activeModel).toBe("gpt-5.4")
    expect(snapshot.providers.find((item) => item.name === "openai")).toMatchObject({
      connected: true,
      active: true,
      credentialSource: "credentials",
      credentialLabel: "OpenHarness 密钥",
      currentModel: "gpt-5.4",
    })
    expect(snapshot.providers.find((item) => item.name === "anthropic")).toMatchObject({
      connected: true,
      credentialSource: "environment",
      credentialLabel: "ANTHROPIC_API_KEY",
    })
    expect(snapshot.providers.find((item) => item.name === "ollama")).toMatchObject({
      connected: true,
      credentialSource: "local",
    })
    expect(snapshot.providers.find((item) => item.name === "codex")).toMatchObject({
      connected: true,
      credentialSource: "subscription",
      credentialLabel: "test@example.com",
    })
    expect(snapshot.providers.map((item) => item.name)).toEqual([
      "openai",
      "anthropic",
      "codex",
      "ollama",
    ])
    expect(snapshot).not.toHaveProperty("subscriptions")
    expect(JSON.stringify(snapshot)).not.toContain("sk-")
  })

  it("does not treat Codex as connected when external auth is missing", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [{ name: "codex", displayName: "Codex Subscription", hasKey: true, active: true }],
      auth: {
        codex: {
          configured: false,
          state: "missing",
          source: "C:/Users/test/.codex/auth.json",
        },
        storedProviders: [],
        envProviders: [],
      },
      settings: { provider: "codex", model: "gpt-5.4" },
      models: [],
    })

    expect(snapshot.providers[0]).toMatchObject({
      connected: false,
      credentialSource: "none",
      active: true,
    })
    expect(snapshot).not.toHaveProperty("subscriptions")
  })
})
