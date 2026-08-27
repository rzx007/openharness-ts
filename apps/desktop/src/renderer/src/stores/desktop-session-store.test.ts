import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopBootstrapData, DesktopSessionView } from "@shared/session-types"
import { createEmptySessionRuntime } from "./desktop-session/operation-state"
import type { QueuedPromptAction } from "./desktop-session-store"
import { useDesktopSessionStore } from "./desktop-session-store"

type TestProject = {
  id: string
  name: string
  path: string
  lastOpenedAt: number
  available: boolean
}

type TestProjectDetails = {
  project: TestProject
  git: boolean
  branch: string | null
  branches: string[]
}

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

function onlyPendingPromptSubmission(): ReturnType<
  typeof useDesktopSessionStore.getState
>["pendingPromptSubmissions"][string] {
  const submissions = Object.values(useDesktopSessionStore.getState().pendingPromptSubmissions)
  expect(submissions).toHaveLength(1)
  return submissions[0]!
}

function emptySessionView(sessionId: string, cursor = 0): DesktopSessionView {
  return {
    cursor,
    syncStatus: "connected",
    session: {
      id: sessionId,
      cwd: "D:\\repo",
      title: "test",
      model: "test-model",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    tasks: [],
    permissions: [],
  }
}

function projectDetails(project: TestProject, branch: string | null = null): TestProjectDetails {
  return {
    project,
    git: Boolean(branch),
    branch,
    branches: branch ? [branch] : [],
  }
}

describe("desktop session store compatibility exports", () => {
  it("keeps QueuedPromptAction available from the legacy store entry", () => {
    const action: QueuedPromptAction = {
      sessionId: "session-1",
      inputId: "input-1",
      runId: "run-1",
      kind: "promote",
      phase: "pending",
    }

    expect(action.kind).toBe("promote")
  })
})

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

  it("keeps a project operation failure out of the active session runtime", async () => {
    const project = {
      id: "project-unavailable",
      name: "Unavailable Project",
      path: "D:\\code\\project-unavailable",
      lastOpenedAt: 100,
      available: true,
    }
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject: vi.fn(async () => {
            throw new Error("project unavailable")
          }),
        },
      },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "s1",
      sessionRuntimes: { s1: createEmptySessionRuntime() },
      projectOperations: {},
    })

    await expect(useDesktopSessionStore.getState().selectProject(project)).rejects.toThrow(
      "project unavailable"
    )

    expect(useDesktopSessionStore.getState().sessionRuntimes.s1?.operations).toEqual({})
    expect(
      Object.values(useDesktopSessionStore.getState().projectOperations[project.id] ?? {})
    ).toContainEqual(expect.objectContaining({ phase: "failed", error: "project unavailable" }))
  })

  it("clears only a retried action's failure after that action succeeds", async () => {
    const project = {
      id: "project-retry",
      name: "Retry Project",
      path: "D:\\code\\project-retry",
      lastOpenedAt: 100,
      available: true,
    }
    const inspectProject = vi
      .fn()
      .mockRejectedValueOnce(new Error("inspect unavailable"))
      .mockResolvedValueOnce(projectDetails(project, "main"))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject,
          checkoutBranch: vi.fn(async () => {
            throw new Error("checkout unavailable")
          }),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      selectedProject: project,
      projectOperations: {},
    })

    await expect(useDesktopSessionStore.getState().checkoutBranch("feature/retry")).rejects.toThrow(
      "checkout unavailable"
    )
    await expect(useDesktopSessionStore.getState().selectProject(project)).rejects.toThrow(
      "inspect unavailable"
    )
    await useDesktopSessionStore.getState().selectProject(project)

    const operations = Object.values(
      useDesktopSessionStore.getState().projectOperations[project.id] ?? {}
    )
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({ phase: "failed", error: "checkout unavailable" })
  })

  it("clears a removed project's operation bucket", async () => {
    const project = {
      id: "project-remove",
      name: "Removed Project",
      path: "D:\\code\\project-remove",
      lastOpenedAt: 100,
      available: true,
    }
    vi.stubGlobal("window", {
      desktop: { sessions: { removeProject: vi.fn(async () => undefined) } },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      selectedProject: null,
      projectOperations: {},
    })

    await useDesktopSessionStore.getState().removeProject(project.path)

    expect(useDesktopSessionStore.getState().projectOperations[project.id]).toBeUndefined()
  })

  it("does not let a late project selection replace the newer selection", async () => {
    const projectA = {
      id: "project-a",
      name: "Project A",
      path: "D:\\code\\project-a",
      lastOpenedAt: 100,
      available: true,
    }
    const projectB = {
      id: "project-b",
      name: "Project B",
      path: "D:\\code\\project-b",
      lastOpenedAt: 200,
      available: true,
    }
    let resolveA!: (value: ReturnType<typeof projectDetails>) => void
    let resolveB!: (value: ReturnType<typeof projectDetails>) => void
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          inspectProject: vi.fn(
            (path: string) =>
              new Promise((resolve) => {
                if (path === projectA.path) resolveA = resolve
                else resolveB = resolve
              })
          ),
        },
      },
    })
    useDesktopSessionStore.setState({ projects: [projectA, projectB], projectOperations: {} })

    const selectingA = useDesktopSessionStore.getState().selectProject(projectA)
    const selectingB = useDesktopSessionStore.getState().selectProject(projectB)
    resolveB(projectDetails(projectB, "branch-b"))
    await selectingB
    resolveA(projectDetails(projectA, "branch-a"))
    await selectingA

    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedProject: projectB,
      branch: "branch-b",
      branches: ["branch-b"],
    })
  })

  it.each([
    ["checkoutBranch", "checkoutBranch"],
    ["createAndCheckoutBranch", "createBranch"],
  ] as const)(
    "does not let a late %s response replace the current project",
    async (action, ipcMethod): Promise<void> => {
      const projectA = {
        id: "project-branch-a",
        name: "Project Branch A",
        path: "D:\\code\\project-branch-a",
        lastOpenedAt: 100,
        available: true,
      }
      const projectB = {
        id: "project-branch-b",
        name: "Project Branch B",
        path: "D:\\code\\project-branch-b",
        lastOpenedAt: 200,
        available: true,
      }
      let resolveBranch!: (value: ReturnType<typeof projectDetails>) => void
      vi.stubGlobal("window", {
        desktop: {
          sessions: {
            inspectProject: vi.fn(async () => projectDetails(projectB, "branch-b")),
            [ipcMethod]: vi.fn(
              () =>
                new Promise((resolve) => {
                  resolveBranch = resolve
                })
            ),
          },
        },
      })
      useDesktopSessionStore.setState({
        projects: [projectA, projectB],
        selectedProject: projectA,
        branch: "branch-a",
        branches: ["branch-a"],
        projectOperations: {},
      })

      const changingBranch = useDesktopSessionStore.getState()[action]("feature/late")
      await useDesktopSessionStore.getState().selectProject(projectB)
      resolveBranch(projectDetails(projectA, "feature/late"))
      await changingBranch

      expect(useDesktopSessionStore.getState()).toMatchObject({
        selectedProject: projectB,
        branch: "branch-b",
        branches: ["branch-b"],
      })
    }
  )
})

describe("desktop session store bootstrap operations", () => {
  it("records a refresh bootstrap failure in app operations", async () => {
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          bootstrap: vi.fn(async () => {
            throw new Error("bootstrap refresh unavailable")
          }),
        },
      },
    })
    useDesktopSessionStore.setState({ appOperations: {} })

    await expect(useDesktopSessionStore.getState().refreshBootstrap()).rejects.toThrow(
      "bootstrap refresh unavailable"
    )

    expect(Object.values(useDesktopSessionStore.getState().appOperations)).toContainEqual(
      expect.objectContaining({ phase: "failed", error: "bootstrap refresh unavailable" })
    )
  })

  it("keeps initialize's app operation until a restored session fails", async () => {
    const restoredSession = emptySessionView("restored-session").session
    const openSession = useDesktopSessionStore.getState().openSession
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => restoredSession.id),
      removeItem: vi.fn(),
    })
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          daemonStatus: vi.fn(async () => ({ phase: "ready", message: "ready", updatedAt: 1 })),
          bootstrap: vi.fn(async () => ({ ...refreshedBootstrap, sessions: [restoredSession] })),
          onDaemonStatusChanged: vi.fn(),
        },
      },
    })
    useDesktopSessionStore.setState({
      loadStatus: "idle",
      appOperations: {},
      openSession: vi.fn(async () => {
        throw new Error("restore unavailable")
      }),
    })

    try {
      await useDesktopSessionStore.getState().initialize()

      expect(Object.values(useDesktopSessionStore.getState().appOperations)).toContainEqual(
        expect.objectContaining({ phase: "failed", error: "restore unavailable" })
      )
    } finally {
      useDesktopSessionStore.setState({ openSession })
      vi.unstubAllGlobals()
    }
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
      id: expect.any(String),
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

  it("marks the first prompt as failed when the new session rejects it", async () => {
    const session = {
      id: "session-first-prompt-fails",
      projectId: "auto-generated-workspace-project",
      workspaceMode: "outside_project" as const,
      cwd: "C:\\Users\\tester\\Documents\\OpenHarness\\2026-08-24\\x2",
      title: "",
      model: "deepseek-chat",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
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
          sendPrompt: vi.fn(async () => {
            throw new Error("发送失败")
          }),
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
      pendingPromptSubmissions: {},
      sending: false,
      openingSession: false,
      error: null,
    })

    await expect(useDesktopSessionStore.getState().startSession("第一条消息")).rejects.toThrow(
      "发送失败"
    )

    expect(onlyPendingPromptSubmission()).toMatchObject({
      sessionId: session.id,
      content: "第一条消息",
      phase: "failed",
      error: "发送失败",
    })
  })

  it("reconciles local prompt state when reopening a session snapshot", async () => {
    const view = emptySessionView("session-reopen", 4)
    view.inputs = [
      {
        id: "input-confirmed",
        sessionId: "session-reopen",
        seq: 1,
        delivery: "queue",
        content: "confirmed",
        metadata: {},
        createdAt: 1,
      },
    ]
    view.runs = [
      {
        id: "run-finished",
        sessionId: "session-reopen",
        inputId: "input-confirmed",
        status: "interrupted",
        metadata: {},
        createdAt: 1,
        updatedAt: 2,
      },
    ]
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          open: vi.fn(async () => view),
        },
      },
    })
    useDesktopSessionStore.setState({
      activeSessionId: null,
      sessionView: null,
      openingSession: false,
      sending: false,
      pendingPromptSubmissions: {
        "input-confirmed": {
          id: "input-confirmed",
          sessionId: "session-reopen",
          content: "confirmed",
          createdAt: 1,
          phase: "accepted",
          placement: "transcript",
        },
      },
      queuedPromptActions: {
        "session-reopen:run-finished": {
          sessionId: "session-reopen",
          inputId: "input-confirmed",
          runId: "run-finished",
          kind: "promote",
          phase: "acknowledged",
        },
      },
    })

    await useDesktopSessionStore.getState().openSession("session-reopen")

    expect(useDesktopSessionStore.getState()).toMatchObject({
      pendingPromptSubmissions: {},
      queuedPromptActions: {},
    })
  })

  it("does not let a late new-session snapshot overwrite a session opened afterward", async () => {
    const sessionA = emptySessionView("session-a").session
    const viewA = { ...emptySessionView("session-a", 1), session: sessionA }
    const viewB = emptySessionView("session-b", 2)
    let resolveViewA!: (view: DesktopSessionView) => void
    const open = vi.fn((sessionId: string) =>
      sessionId === "session-a"
        ? new Promise<DesktopSessionView>((resolve) => {
            resolveViewA = resolve
          })
        : Promise.resolve(viewB)
    )
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => sessionA),
          open,
          sendPrompt: vi.fn(async () => undefined),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [],
      sessions: [],
      archivedSessions: [],
      workspaceMode: "outside_project",
      selectedProject: null,
      selectedModel: "test-model",
      selectedProvider: null,
      defaultModel: "test-model",
      defaultProvider: null,
      selectedPermissionMode: "default",
      activeSessionId: null,
      sessionView: null,
      pendingPromptSubmissions: {},
      sending: false,
      openingSession: false,
      error: null,
    })

    const starting = useDesktopSessionStore.getState().startSession("start A")
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("session-a"))
    await useDesktopSessionStore.getState().openSession("session-b")
    resolveViewA(viewA)
    await starting

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: "session-b",
      sessionView: { session: { id: "session-b" }, cursor: 2 },
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

describe("desktop session store prompt intent boundaries", () => {
  beforeEach(() => {
    useDesktopSessionStore.setState({
      activeSessionId: null,
      sessionView: null,
      sending: false,
      sendingOperationId: null,
      error: null,
      pendingPromptSubmissions: {},
      pendingPromptEdit: null,
      queuedPromptActions: {},
      sessionRuntimes: {},
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps normal composer sends on sendPrompt after an interrupted run", async () => {
    const sendPrompt = vi.fn(async () => undefined)
    const editLatestPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: { sessions: { sendPrompt, editLatestPrompt } },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sending: false,
      error: null,
      sessionView: {
        cursor: 1,
        syncStatus: "connected",
        session: {
          id: "session-1",
          cwd: "D:\\repo",
          title: "test",
          model: "test-model",
          status: "idle",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        inputs: [],
        messages: [],
        parts: [],
        runs: [
          {
            id: "interrupted-run",
            sessionId: "session-1",
            status: "interrupted",
            metadata: {},
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        tasks: [],
        permissions: [],
      },
    })

    await useDesktopSessionStore.getState().sendMessage("new request")

    expect(sendPrompt).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: "session-1",
      content: "new request",
    })
    expect(editLatestPrompt).not.toHaveBeenCalled()
  })

  it("does not leave a normal prompt placeholder for a slash command", async () => {
    const invokeCommand = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          invokeCommand,
        },
      },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sending: false,
      pendingPromptSubmissions: {},
      error: null,
    })

    await useDesktopSessionStore.getState().sendMessage("/compact", { commandLine: "/compact" })

    expect(invokeCommand).toHaveBeenCalledWith({ sessionId: "session-1", line: "/compact" })
    expect(useDesktopSessionStore.getState().pendingPromptSubmissions).toEqual({})
  })

  it("does not let an old session request clear a newer session sending state", async () => {
    let resolveOld!: () => void
    let resolveNew!: () => void
    const sendPrompt = vi.fn(({ content }: { content: string }) => {
      return new Promise<void>((resolve) => {
        if (content === "old request") resolveOld = resolve
        else resolveNew = resolve
      })
    })
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-old",
      sending: false,
      pendingPromptSubmissions: {},
      error: null,
    })

    const oldRequest = useDesktopSessionStore.getState().sendMessage("old request")
    useDesktopSessionStore.setState({ activeSessionId: "session-new", sending: false })
    const newRequest = useDesktopSessionStore.getState().sendMessage("new request")

    resolveOld()
    await oldRequest
    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: "session-new",
      sending: true,
    })

    resolveNew()
    await newRequest
    expect(useDesktopSessionStore.getState().sending).toBe(false)
  })

  it("keeps a successful submission visible until the session stream confirms it", async () => {
    let resolveSend!: () => void
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sending: false,
      error: null,
      pendingPromptSubmissions: {},
    })

    const request = useDesktopSessionStore.getState().sendMessage("new request")

    expect(onlyPendingPromptSubmission()).toMatchObject({
      sessionId: "session-1",
      content: "new request",
      phase: "submitting",
      placement: "transcript",
    })

    resolveSend()
    await request

    expect(onlyPendingPromptSubmission()).toMatchObject({
      sessionId: "session-1",
      content: "new request",
      phase: "accepted",
      placement: "transcript",
    })
  })

  it("marks a submission as queued when another run is already active", async () => {
    let resolveSend!: () => void
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    const runningView = emptySessionView("session-1")
    runningView.session.status = "running"
    runningView.runs = [
      {
        id: "run-active",
        sessionId: "session-1",
        inputId: "input-active",
        status: "running",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: runningView,
      sending: false,
      error: null,
      pendingPromptSubmissions: {},
    })

    const request = useDesktopSessionStore.getState().sendMessage("queued request")

    expect(onlyPendingPromptSubmission()).toMatchObject({
      content: "queued request",
      phase: "submitting",
      placement: "queue",
    })

    resolveSend()
    await request
  })

  it("keeps multiple accepted submissions until each one is confirmed", async () => {
    const sendPrompt = vi.fn(async (input: { id: string; sessionId: string; content: string }) => {
      void input
    })
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
      sending: false,
      pendingPromptSubmissions: {},
      error: null,
    })

    await useDesktopSessionStore.getState().sendMessage("first request")
    await useDesktopSessionStore.getState().sendMessage("second request")

    const firstCall = sendPrompt.mock.calls[0]!
    const secondCall = sendPrompt.mock.calls[1]!
    expect(Object.values(useDesktopSessionStore.getState().pendingPromptSubmissions)).toHaveLength(
      2
    )
    expect(
      useDesktopSessionStore.getState().pendingPromptSubmissions[firstCall[0].id]
    ).toMatchObject({ placement: "transcript" })
    expect(
      useDesktopSessionStore.getState().pendingPromptSubmissions[secondCall[0].id]
    ).toMatchObject({ placement: "queue" })

    useDesktopSessionStore.getState().applySessionUpdate({
      ...emptySessionView("session-1", 1),
      inputs: [
        {
          id: firstCall[0].id,
          sessionId: "session-1",
          seq: 1,
          delivery: "queue",
          content: "first request",
          metadata: {},
          createdAt: 1,
        },
      ],
    })

    expect(Object.keys(useDesktopSessionStore.getState().pendingPromptSubmissions)).toEqual([
      secondCall[0].id,
    ])
  })

  it("treats an SSE-confirmed submission as successful when the IPC response is lost", async () => {
    let rejectSend!: (error: Error) => void
    const sendPrompt = vi.fn((input: { id: string; sessionId: string; content: string }) => {
      void input
      return new Promise<void>((_resolve, reject) => {
        rejectSend = reject
      })
    })
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
      sending: false,
      pendingPromptSubmissions: {},
      error: null,
    })

    const request = useDesktopSessionStore.getState().sendMessage("confirmed request")
    const inputId = sendPrompt.mock.calls[0]![0].id
    useDesktopSessionStore.getState().applySessionUpdate({
      ...emptySessionView("session-1", 1),
      inputs: [
        {
          id: inputId,
          sessionId: "session-1",
          seq: 1,
          delivery: "queue",
          content: "confirmed request",
          metadata: {},
          createdAt: 1,
        },
      ],
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-2",
      sessionView: emptySessionView("session-2", 1),
      error: null,
    })
    rejectSend(new Error("response lost"))

    await expect(request).resolves.toBeUndefined()
    expect(useDesktopSessionStore.getState()).toMatchObject({
      pendingPromptSubmissions: {},
      error: null,
    })
  })

  it("reuses the same input id when an uncertain send is retried", async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(undefined)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sending: false,
      error: null,
      pendingPromptSubmissions: {},
    })

    await expect(useDesktopSessionStore.getState().sendMessage("retry me")).rejects.toThrow(
      "response lost"
    )
    await useDesktopSessionStore.getState().sendMessage("retry me")

    expect(sendPrompt).toHaveBeenCalledTimes(2)
    expect(sendPrompt.mock.calls[1]?.[0].id).toBe(sendPrompt.mock.calls[0]?.[0].id)
    expect(onlyPendingPromptSubmission()).toMatchObject({
      content: "retry me",
      phase: "accepted",
    })
  })

  it("includes the selected source message when explicitly editing", async () => {
    const editLatestPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: { sessions: { editLatestPrompt } },
    })
    useDesktopSessionStore.setState({ activeSessionId: "session-1", sending: false, error: null })

    await useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")

    expect(editLatestPrompt).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: "session-1",
      sourceMessageId: "message-1",
      content: "replacement",
    })
  })

  it("reuses the same edit id when an uncertain edit is retried", async () => {
    const editLatestPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(undefined)
    vi.stubGlobal("window", {
      desktop: { sessions: { editLatestPrompt } },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sending: false,
      error: null,
      pendingPromptEdit: null,
    })

    await expect(
      useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")
    ).rejects.toThrow("response lost")
    await useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")

    expect(editLatestPrompt).toHaveBeenCalledTimes(2)
    expect(editLatestPrompt.mock.calls[1]?.[0].id).toBe(editLatestPrompt.mock.calls[0]?.[0].id)
    expect(useDesktopSessionStore.getState().pendingPromptEdit).toBeNull()
  })

  it("does not let an old edit settle a newer session send", async () => {
    let resolveEdit!: () => void
    let resolveSend!: () => void
    const editLatestPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveEdit = resolve
        })
    )
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        })
    )
    vi.stubGlobal("window", {
      desktop: { sessions: { editLatestPrompt, sendPrompt } },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sending: false,
      sendingOperationId: null,
      pendingPromptSubmissions: {},
      pendingPromptEdit: null,
      error: null,
    })

    const editing = useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")
    useDesktopSessionStore.setState({
      activeSessionId: "session-2",
      sending: false,
      sendingOperationId: null,
    })
    const sending = useDesktopSessionStore.getState().sendMessage("new session request")

    resolveEdit()
    await editing
    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: "session-2",
      sending: true,
    })

    resolveSend()
    await sending
    expect(useDesktopSessionStore.getState().sending).toBe(false)
  })

  it("binds stop to the active run visible at click time", async () => {
    const interrupt = vi.fn(async () => undefined)
    vi.stubGlobal("window", { desktop: { sessions: { interrupt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: {
        ...emptySessionView("session-1"),
        runs: [
          {
            id: "run-at-click",
            sessionId: "session-1",
            status: "running",
            metadata: {},
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    })

    await useDesktopSessionStore.getState().interrupt()

    expect(interrupt).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedRunId: "run-at-click",
    })
  })

  it("promotes and cancels the exact durable queued prompt", async () => {
    const promoteQueuedPrompt = vi.fn(async () => undefined)
    const cancelQueuedPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: { sessions: { promoteQueuedPrompt, cancelQueuedPrompt } },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      queuedPromptActions: {},
      error: null,
    })

    await useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")
    await useDesktopSessionStore.getState().cancelQueuedPrompt("input-other", "run-other")

    expect(promoteQueuedPrompt).toHaveBeenCalledWith({
      sessionId: "session-1",
      inputId: "input-queued",
      queuedRunId: "run-queued",
      expectedActiveRunId: "run-active",
    })
    expect(cancelQueuedPrompt).toHaveBeenCalledWith({
      sessionId: "session-1",
      inputId: "input-other",
      queuedRunId: "run-other",
    })
    expect(Object.values(useDesktopSessionStore.getState().queuedPromptActions)).toEqual([
      expect.objectContaining({ runId: "run-queued", phase: "acknowledged" }),
      expect.objectContaining({ runId: "run-other", phase: "acknowledged" }),
    ])
  })

  it("keeps a promoted run acknowledged until the session stream confirms it", async () => {
    let resolvePromote!: () => void
    const promoteQueuedPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePromote = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
      error: null,
      queuedPromptActions: {},
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")

    expect(useDesktopSessionStore.getState().queuedPromptActions).toMatchObject({
      "session-1:run-queued": {
        sessionId: "session-1",
        runId: "run-queued",
        kind: "promote",
        phase: "pending",
      },
    })

    resolvePromote()
    await request

    expect(useDesktopSessionStore.getState().queuedPromptActions).toMatchObject({
      "session-1:run-queued": {
        sessionId: "session-1",
        runId: "run-queued",
        kind: "promote",
        phase: "acknowledged",
      },
    })
  })

  it("does not report an action failure after SSE already confirmed it", async () => {
    let rejectPromote!: (error: Error) => void
    const promoteQueuedPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPromote = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    const pendingView = emptySessionView("session-1", 1)
    pendingView.runs = [
      {
        id: "run-queued",
        sessionId: "session-1",
        inputId: "input-queued",
        status: "pending",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: pendingView,
      error: null,
      queuedPromptActions: {},
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")
    useDesktopSessionStore.getState().applySessionUpdate({
      ...pendingView,
      cursor: 2,
      runs: [{ ...pendingView.runs[0], status: "interrupted", updatedAt: 2 }],
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-2",
      sessionView: emptySessionView("session-2", 1),
      error: null,
    })
    rejectPromote(new Error("response lost"))
    await request

    expect(useDesktopSessionStore.getState()).toMatchObject({
      queuedPromptActions: {},
      error: null,
    })
  })

  it("keeps an action failure on its queued run with a readable message", async () => {
    const promoteQueuedPrompt = vi.fn(async () => {
      throw new Error("Active run changed")
    })
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
      error: null,
      queuedPromptActions: {},
    })

    await useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")

    expect(useDesktopSessionStore.getState().queuedPromptActions).toMatchObject({
      "session-1:run-queued": {
        phase: "failed",
        error: "当前回答已经切换，这条消息仍保留在待处理队列中。",
      },
    })
  })

  it("does not leak an old session action error into the newly opened session", async () => {
    let rejectPromote!: (error: Error) => void
    const promoteQueuedPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPromote = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
      error: null,
      queuedPromptActions: {},
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")
    useDesktopSessionStore.setState({ activeSessionId: "session-2", error: null })
    rejectPromote(new Error("Active run changed"))
    await request

    expect(useDesktopSessionStore.getState().error).toBeNull()
    expect(
      useDesktopSessionStore.getState().sessionRuntimes["session-1"]?.queuedPromptActions
    ).toMatchObject({
      "session-1:run-queued": { phase: "failed" },
    })
  })

  it("clears an acknowledged queue action when SSE reports the run terminal", () => {
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      queuedPromptActions: {
        "session-1:run-queued": {
          sessionId: "session-1",
          inputId: "input-queued",
          runId: "run-queued",
          kind: "promote",
          phase: "acknowledged",
        },
      },
      sessionRuntimes: {
        "session-1": {
          ...createEmptySessionRuntime(),
          queuedPromptActions: {
            "session-1:run-queued": {
              sessionId: "session-1",
              inputId: "input-queued",
              runId: "run-queued",
              kind: "promote",
              phase: "acknowledged",
            },
          },
        },
      },
      sessionView: null,
    })

    useDesktopSessionStore.getState().applySessionUpdate({
      cursor: 9,
      syncStatus: "connected",
      session: {
        id: "session-1",
        cwd: "D:\\repo",
        title: "test",
        model: "test-model",
        status: "running",
        metadata: {},
        createdAt: 1,
        updatedAt: 9,
      },
      inputs: [],
      messages: [],
      parts: [],
      runs: [
        {
          id: "run-queued",
          sessionId: "session-1",
          inputId: "input-queued",
          status: "interrupted",
          metadata: {},
          createdAt: 2,
          updatedAt: 9,
        },
      ],
      tasks: [],
      permissions: [],
    })

    expect(useDesktopSessionStore.getState().queuedPromptActions).toEqual({})
  })
})
