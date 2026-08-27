import { afterEach, describe, expect, it, vi } from "vitest"

import type { DesktopSessionView } from "@shared/session-types"
import { useDesktopSessionStore } from "../desktop-session-store"

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

function resetNewConversationState(): void {
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
    sendingOperationId: null,
    openingSession: false,
    error: null,
    newConversationRuntime: {
      operations: {},
      pendingPromptSubmissions: {},
      pendingPromptEdit: null,
      queuedPromptActions: {},
    },
    sessionRuntimes: {},
  })
}

describe("desktop session actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("does not let a late create steal the primary subscription", async () => {
    const sessionA = emptySessionView("session-a").session
    let resolveCreate!: (session: typeof sessionA) => void
    const create = vi.fn(
      () =>
        new Promise<typeof sessionA>((resolve) => {
          resolveCreate = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create,
          open,
          sendPrompt: vi.fn(async () => undefined),
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore.getState().startSession("start A")
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    await useDesktopSessionStore.getState().openSession("session-b")
    resolveCreate(sessionA)
    await starting

    expect(useDesktopSessionStore.getState().activeSessionId).toBe("session-b")
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith("session-b")
  })

  it("does not let an older open snapshot replace a newer SSE view", async () => {
    let resolveOpen!: (view: DesktopSessionView) => void
    const open = vi.fn(
      () =>
        new Promise<DesktopSessionView>((resolve) => {
          resolveOpen = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { open } } })
    resetNewConversationState()

    const opening = useDesktopSessionStore.getState().openSession("session-1")
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("session-1"))
    useDesktopSessionStore.getState().applySessionUpdate(emptySessionView("session-1", 5))
    resolveOpen(emptySessionView("session-1", 2))
    await opening

    expect(useDesktopSessionStore.getState().sessionView?.cursor).toBe(5)
  })

  it("only lets the latest same-session open request apply its snapshot", async () => {
    const resolvers: Array<(view: DesktopSessionView) => void> = []
    const open = vi.fn(
      () =>
        new Promise<DesktopSessionView>((resolve) => {
          resolvers.push(resolve)
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { open } } })
    resetNewConversationState()

    const firstOpening = useDesktopSessionStore.getState().openSession("session-1")
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const secondOpening = useDesktopSessionStore.getState().openSession("session-1")
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))

    resolvers[0]!(emptySessionView("session-1", 20))
    await firstOpening

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: "session-1",
      sessionView: null,
      openingSession: true,
    })

    resolvers[1]!(emptySessionView("session-1", 2))
    await secondOpening

    expect(useDesktopSessionStore.getState().sessionView?.cursor).toBe(2)
  })

  it("does not let the first A open win after A/B/A navigation", async () => {
    const aResolvers: Array<(view: DesktopSessionView) => void> = []
    const open = vi.fn((sessionId: string) => {
      if (sessionId === "session-b") return Promise.resolve(emptySessionView(sessionId, 5))
      return new Promise<DesktopSessionView>((resolve) => {
        aResolvers.push(resolve)
      })
    })
    vi.stubGlobal("window", { desktop: { sessions: { open } } })
    resetNewConversationState()

    const firstA = useDesktopSessionStore.getState().openSession("session-a")
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    await useDesktopSessionStore.getState().openSession("session-b")
    const secondA = useDesktopSessionStore.getState().openSession("session-a")
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(3))

    aResolvers[0]!(emptySessionView("session-a", 30))
    await firstA
    aResolvers[1]!(emptySessionView("session-a", 3))
    await secondA

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: "session-a",
      sessionView: { cursor: 3, session: { id: "session-a" } },
    })
  })

  it("does not let a late fork steal the primary subscription", async () => {
    const source = emptySessionView("session-a").session
    const forked = { ...emptySessionView("session-fork").session, title: "forked" }
    let resolveFork!: (session: typeof forked) => void
    const fork = vi.fn(
      () =>
        new Promise<typeof forked>((resolve) => {
          resolveFork = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1))
    vi.stubGlobal("window", { desktop: { sessions: { fork, open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({ sessions: [source], activeSessionId: source.id })

    const forking = useDesktopSessionStore.getState().forkSession(source.id)
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce())
    await useDesktopSessionStore.getState().openSession("session-b")
    resolveFork(forked)
    await forking

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith("session-b")
    expect(useDesktopSessionStore.getState().sessions).toContainEqual(forked)
  })

  it("keeps create acknowledged and records the first prompt failure on its submission", async () => {
    const session = emptySessionView("session-created").session
    let resolveCreate!: (value: typeof session) => void
    const create = vi.fn(
      () =>
        new Promise<typeof session>((resolve) => {
          resolveCreate = resolve
        })
    )
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create,
          open: vi.fn(async (sessionId: string) => emptySessionView(sessionId)),
          sendPrompt: vi.fn(async () => {
            throw new Error("first prompt failed")
          }),
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore.getState().startSession("first prompt")
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    await useDesktopSessionStore.getState().openSession("session-b")
    resolveCreate(session)

    await expect(starting).rejects.toThrow("first prompt failed")

    const runtime = useDesktopSessionStore.getState().sessionRuntimes[session.id]
    expect(Object.values(runtime?.operations ?? {})).toContainEqual(
      expect.objectContaining({ kind: "create-session", phase: "acknowledged" })
    )
    expect(Object.values(runtime?.pendingPromptSubmissions ?? {})).toContainEqual(
      expect.objectContaining({ phase: "failed", error: "first prompt failed" })
    )
  })

  it("keeps create acknowledged and records a first slash-command failure separately", async () => {
    const session = emptySessionView("session-command").session
    let resolveCreate!: (value: typeof session) => void
    const create = vi.fn(
      () =>
        new Promise<typeof session>((resolve) => {
          resolveCreate = resolve
        })
    )
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create,
          open: vi.fn(async (sessionId: string) => emptySessionView(sessionId)),
          invokeCommand: vi.fn(async () => {
            throw new Error("first command failed")
          }),
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore
      .getState()
      .startSession("/compact", { commandLine: "/compact" })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    await useDesktopSessionStore.getState().openSession("session-b")
    resolveCreate(session)

    await expect(starting).rejects.toThrow("first command failed")

    const operations = Object.values(
      useDesktopSessionStore.getState().sessionRuntimes[session.id]?.operations ?? {}
    )
    expect(operations).toContainEqual(
      expect.objectContaining({ kind: "create-session", phase: "acknowledged" })
    )
    expect(operations).toContainEqual(
      expect.objectContaining({
        kind: "invoke-command",
        phase: "failed",
        error: "first command failed",
      })
    )
  })

  it("binds the first submission and create operation to the created session runtime", async () => {
    const session = emptySessionView("session-created").session
    let resolvePrompt!: () => void
    let operationsWhenOpening: ReturnType<
      typeof useDesktopSessionStore.getState
    >["sessionRuntimes"][string]["operations"] = {}
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async () => {
            operationsWhenOpening = {
              ...useDesktopSessionStore.getState().sessionRuntimes[session.id]?.operations,
            }
            return emptySessionView(session.id)
          }),
          sendPrompt: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                resolvePrompt = resolve
              })
          ),
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore.getState().startSession("first prompt")
    await vi.waitFor(() => expect(resolvePrompt).toBeTypeOf("function"))

    const runtime = useDesktopSessionStore.getState().sessionRuntimes[session.id]
    expect(Object.values(runtime?.pendingPromptSubmissions ?? {})).toContainEqual(
      expect.objectContaining({ content: "first prompt", sessionId: session.id })
    )
    expect(Object.values(operationsWhenOpening)).toContainEqual(
      expect.objectContaining({ kind: "create-session", sessionId: session.id })
    )

    resolvePrompt()
    await starting
  })
})
