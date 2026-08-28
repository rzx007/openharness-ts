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
    expect(snapshot.providers.find((item) => item.name === "codex")).toMatchObject({
      connected: true,
      credentialSource: "subscription",
      credentialLabel: "test@example.com",
    })
    expect(snapshot.providers.map((item) => item.name)).toEqual(["openai", "anthropic", "codex"])
    expect(snapshot).not.toHaveProperty("subscriptions")
    expect(JSON.stringify(snapshot)).not.toContain("sk-")
  })

  it("merges editable custom provider metadata without requiring an API key", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [
        {
          name: "office-gateway",
          displayName: "Office Gateway",
          hasKey: false,
          active: false,
          custom: true,
          requiresApiKey: false,
        },
      ],
      auth: {
        codex: { configured: false, state: "missing", source: "none" },
        storedProviders: [],
        envProviders: [],
      },
      settings: {
        customProviders: [
          {
            id: "office-gateway",
            displayName: "Office Gateway",
            baseUrl: "https://gateway.example/v1",
            apiFormat: "openai",
            models: [{
              id: "team-model",
              displayName: "Team Model",
              imageInputSupport: "native",
            }],
            headers: { "X-Tenant": "desktop" },
          },
        ],
      },
      models: [
        {
          name: "office-gateway",
          displayName: "Office Gateway",
          models: [
            {
              id: "team-model",
              label: "Team Model",
              provider: "Office Gateway",
              providerName: "office-gateway",
              inputCapabilities: { image: "native" },
            },
          ],
        },
      ],
    })

    expect(snapshot.providers[0]).toMatchObject({
      custom: true,
      connected: true,
      credentialSource: "configured",
      baseUrl: "https://gateway.example/v1",
      headers: { "X-Tenant": "desktop" },
      models: [{
        id: "team-model",
        label: "Team Model",
        imageInputSupport: "native",
      }],
    })
  })

  it("treats models.dev providers as credential-backed catalog connections", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [
        {
          name: "remote",
          displayName: "Remote AI",
          hasKey: true,
          active: false,
          source: "catalog",
        },
      ],
      auth: {
        codex: { configured: false, state: "missing", source: "none" },
        storedProviders: ["remote"],
        envProviders: [],
      },
      settings: {
        customProviders: [
          {
            id: "remote",
            displayName: "Remote AI",
            baseUrl: "https://remote.example/v1",
            apiFormat: "openai",
            source: "models.dev",
            models: [{ id: "remote-chat", displayName: "Remote Chat" }],
          },
        ],
      },
      models: [
        {
          name: "remote",
          displayName: "Remote AI",
          models: [
            {
              id: "remote-chat",
              label: "Remote Chat",
              provider: "Remote AI",
              providerName: "remote",
            },
          ],
        },
      ],
    })

    expect(snapshot.providers[0]).toMatchObject({
      source: "catalog",
      connected: true,
      credentialSource: "credentials",
      models: [{ id: "remote-chat", label: "Remote Chat" }],
    })
    expect(snapshot.providers[0]).not.toHaveProperty("custom")
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

  it("uses the resolved runtime selection so provider snapshot matches bootstrap fallback", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [
        { name: "openai", displayName: "OpenAI", hasKey: true, active: true },
        { name: "gemini", displayName: "Gemini", hasKey: true, active: false },
      ],
      auth: {
        codex: { configured: false, state: "missing", source: "none" },
        storedProviders: ["openai", "gemini"],
        envProviders: [],
      },
      settings: { provider: "gemini", model: "gpt-5.4" },
      models: [
        {
          name: "openai",
          displayName: "OpenAI",
          models: [{ id: "gpt-5.4", label: "GPT-5.4", provider: "OpenAI", providerName: "openai" }],
        },
        {
          name: "gemini",
          displayName: "Gemini",
          models: [
            {
              id: "gemini-2.5-pro",
              label: "Gemini 2.5 Pro",
              provider: "Gemini",
              providerName: "gemini",
            },
          ],
        },
      ],
    })

    expect(snapshot.activeProvider).toBe("gemini")
    expect(snapshot.activeModel).toBe("gemini-2.5-pro")
    expect(snapshot.providers.find((item) => item.name === "gemini")).toMatchObject({
      active: true,
      currentModel: "gemini-2.5-pro",
    })
    expect(snapshot.providers.find((item) => item.name === "openai")).toMatchObject({
      active: false,
    })
  })

  it("does not keep built-in providers connected when auth cannot attribute a source", () => {
    const snapshot = buildDesktopProviderSnapshot({
      providers: [{ name: "deepseek", displayName: "DeepSeek", hasKey: true, active: false }],
      auth: {
        codex: { configured: false, state: "missing", source: "none" },
        storedProviders: [],
        envProviders: [],
      },
      settings: {},
      models: [],
    })

    expect(snapshot.providers[0]).toMatchObject({
      connected: false,
      credentialSource: "none",
    })
  })
})
