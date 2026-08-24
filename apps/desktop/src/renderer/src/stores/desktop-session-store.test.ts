import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopBootstrapData } from "@shared/session-types"
import { useDesktopSessionStore } from "./desktop-session-store"

const refreshedBootstrap: DesktopBootstrapData = {
  connected: true,
  outsideProjectCwd: "C:\\Users\\tester",
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

  it("keeps the outside-project selection while refreshing settings", async () => {
    useDesktopSessionStore.setState({
      workspaceMode: "outside_project",
      selectedProject: null,
    })

    await useDesktopSessionStore.getState().refreshBootstrap()

    expect(useDesktopSessionStore.getState()).toMatchObject({
      workspaceMode: "outside_project",
      selectedProject: null,
      outsideProjectCwd: "C:\\Users\\tester",
    })
  })
})

describe("desktop session store outside-project mode", () => {
  it("creates a session in the home directory without a project id", async () => {
    const session = {
      id: "session-outside-project",
      cwd: "C:\\Users\\tester",
      title: "",
      model: "deepseek-chat",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const create = vi.fn(async () => session)
    const sendPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create,
          open: vi.fn(async () => ({
            cursor: 0,
            syncStatus: "connected" as const,
            session,
            inputs: [],
            messages: [],
            parts: [],
            runs: [],
            tasks: [],
            permissions: [],
          })),
          sendPrompt,
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [],
      sessions: [],
      archivedSessions: [],
      workspaceMode: "outside_project",
      outsideProjectCwd: "C:\\Users\\tester",
      selectedProject: null,
      selectedModel: "deepseek-chat",
      selectedProvider: "deepseek",
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
      selectedPermissionMode: "default",
      activeSessionId: null,
      sessionView: null,
      sending: false,
      openingSession: false,
      error: null,
    })

    await useDesktopSessionStore.getState().startSession("总结今天的安排")

    expect(create).toHaveBeenCalledWith({
      cwd: "C:\\Users\\tester",
      model: "deepseek-chat",
      provider: "deepseek",
      permissionMode: "default",
    })
    expect(sendPrompt).toHaveBeenCalledWith({
      sessionId: "session-outside-project",
      content: "总结今天的安排",
    })
    expect(useDesktopSessionStore.getState()).toMatchObject({
      workspaceMode: "outside_project",
      selectedProject: null,
      activeSessionId: "session-outside-project",
    })
  })
})
