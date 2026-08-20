import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopBootstrapData } from "@shared/session-types"
import { useDesktopSessionStore } from "./desktop-session-store"

const refreshedBootstrap: DesktopBootstrapData = {
  connected: true,
  projects: [],
  sessions: [],
  archivedSessions: [],
  models: [
    {
      id: "deepseek-chat",
      label: "DeepSeek Chat",
      provider: "DeepSeek",
      providerName: "deepseek",
    },
  ],
  defaultModel: "deepseek-chat",
  defaultProvider: "deepseek",
  defaultPermissionMode: "default",
}

describe("desktop session store provider refresh", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          bootstrap: vi.fn(async () => refreshedBootstrap),
        },
      },
    })
    useDesktopSessionStore.setState({
      loadStatus: "ready",
      activeSessionId: null,
      sessionView: null,
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          provider: "OpenAI",
          providerName: "openai",
        },
      ],
      defaultModel: "gpt-5.4",
      defaultProvider: "openai",
      selectedModel: "gpt-5.4",
      selectedProvider: "openai",
    })
  })

  it("refreshes the new-conversation provider and model after settings change", async () => {
    await useDesktopSessionStore.getState().refreshBootstrap()

    expect(useDesktopSessionStore.getState()).toMatchObject({
      models: refreshedBootstrap.models,
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
      selectedModel: "deepseek-chat",
      selectedProvider: "deepseek",
    })
  })

  it("keeps the open session runtime selection while refreshing global defaults", async () => {
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      selectedPermissionMode: "plan",
    })

    await useDesktopSessionStore.getState().refreshBootstrap()

    expect(useDesktopSessionStore.getState()).toMatchObject({
      models: refreshedBootstrap.models,
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
      selectedModel: "gpt-5.4",
      selectedProvider: "openai",
      selectedPermissionMode: "plan",
    })
  })
})
