import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

  it("keeps the outside-project selection while refreshing settings", async () => {
    useDesktopSessionStore.setState({
      workspaceMode: "outside_project",
      selectedProject: null,
    })

    await useDesktopSessionStore.getState().refreshBootstrap()

    expect(useDesktopSessionStore.getState()).toMatchObject({
      workspaceMode: "outside_project",
      selectedProject: null,
    })
  })
})

describe("desktop session store project order", () => {
  it("keeps the project list stable when selecting a project", async () => {
    const projects = [
      {
        id: "project-a",
        name: "Project A",
        path: "D:\\code\\project-a",
        lastOpenedAt: 300,
        available: true,
      },
      {
        id: "project-b",
        name: "Project B",
        path: "D:\\code\\project-b",
        lastOpenedAt: 200,
        available: true,
      },
      {
        id: "project-c",
        name: "Project C",
        path: "D:\\code\\project-c",
        lastOpenedAt: 100,
        available: true,
      },
    ]
    const inspectedProject = { ...projects[1], lastOpenedAt: 400 }
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject: vi.fn(async () => ({
            project: inspectedProject,
            git: false,
            branch: null,
            branches: [],
          })),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects,
      workspaceMode: "project",
      selectedProject: projects[0],
      selectedProjectGit: false,
      branch: null,
      branches: [],
      error: null,
    })

    await useDesktopSessionStore.getState().selectProject(projects[1])

    expect(useDesktopSessionStore.getState().projects.map((project) => project.id)).toEqual([
      "project-a",
      "project-b",
      "project-c",
    ])
    expect(useDesktopSessionStore.getState().projects[1]).toEqual(inspectedProject)
  })
})

describe("desktop session store git state refresh", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("uses the git cache until a forced refresh is requested", async () => {
    const project = {
      id: "project-a",
      name: "Project A",
      path: "D:\\code\\project-a",
      lastOpenedAt: 100,
      available: true,
    }
    const inspectProject = vi.fn(async () => ({
      project,
      git: true,
      branch: "main",
      branches: ["main"],
    }))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject,
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      workspaceMode: "project",
      selectedProject: project,
      selectedProjectGit: false,
      selectedProjectGitCheckedAt: Date.now(),
      branch: null,
      branches: [],
    })

    await expect(useDesktopSessionStore.getState().refreshSelectedProjectGit()).resolves.toBe(false)
    expect(inspectProject).not.toHaveBeenCalled()

    await expect(
      useDesktopSessionStore.getState().refreshSelectedProjectGit({ force: true })
    ).resolves.toBe(true)

    expect(inspectProject).toHaveBeenCalledWith(project.path)
    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedProjectGit: true,
      branch: "main",
      branches: ["main"],
    })
  })

  it("refreshes a previously non-git project after session updates", async () => {
    vi.useFakeTimers()
    const project = {
      id: "project-a",
      name: "Project A",
      path: "D:\\code\\project-a",
      lastOpenedAt: 100,
      available: true,
    }
    const inspectProject = vi.fn(async () => ({
      project,
      git: true,
      branch: "main",
      branches: ["main"],
    }))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject,
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      workspaceMode: "project",
      selectedProject: project,
      selectedProjectGit: false,
      selectedProjectGitCheckedAt: Date.now(),
      branch: null,
      branches: [],
      activeSessionId: "session-1",
      sessionView: null,
    })

    useDesktopSessionStore.getState().applySessionUpdate({
      cursor: 1,
      syncStatus: "connected",
      session: {
        id: "session-1",
        projectId: project.id,
        workspaceMode: "project",
        cwd: project.path,
        title: "Git init",
        model: "deepseek-chat",
        status: "idle",
        metadata: {},
        createdAt: 1,
        updatedAt: 2,
      },
      inputs: [],
      messages: [],
      parts: [],
      runs: [],
      tasks: [],
      permissions: [],
    })
    await vi.advanceTimersByTimeAsync(750)

    expect(inspectProject).toHaveBeenCalledWith(project.path)
    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedProjectGit: true,
      branch: "main",
      branches: ["main"],
    })
  })
})

describe("desktop session store outside-project mode", () => {
  it("lets the main process allocate the directory for a session without a project id", async () => {
    const session = {
      id: "session-outside-project",
      projectId: "auto-generated-workspace-project",
      workspaceMode: "outside_project" as const,
      cwd: "C:\\Users\\tester\\Documents\\OpenHarness\\2026-08-24\\x1",
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
      sessions: [
        {
          id: "session-outside-project",
          projectId: "auto-generated-workspace-project",
          workspaceMode: "outside_project",
        },
      ],
    })
  })

  it("keeps the internal xN workspace hidden after opening a session and starting a new one", async () => {
    const session = {
      id: "session-outside-project",
      projectId: "auto-generated-workspace-project",
      workspaceMode: "outside_project" as const,
      cwd: "C:\\Users\\tester\\Documents\\OpenHarness\\2026-08-24\\x1",
      title: "项目外会话",
      model: "deepseek-chat",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const close = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          close,
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
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [],
      sessions: [session],
      archivedSessions: [],
      workspaceMode: "project",
      selectedProject: {
        id: session.projectId,
        name: "x1",
        path: session.cwd,
        lastOpenedAt: 1,
        available: true,
      },
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
      defaultPermissionMode: "default",
      activeSessionId: null,
      sessionView: null,
      openingSession: false,
      sending: false,
      error: null,
    })

    await useDesktopSessionStore.getState().openSession(session.id)

    expect(useDesktopSessionStore.getState()).toMatchObject({
      workspaceMode: "outside_project",
      selectedProject: null,
      activeSessionId: session.id,
    })

    await useDesktopSessionStore.getState().startNewConversation()

    expect(close).toHaveBeenCalledOnce()
    expect(useDesktopSessionStore.getState()).toMatchObject({
      workspaceMode: "outside_project",
      selectedProject: null,
      activeSessionId: null,
      sessionView: null,
    })
  })
})
