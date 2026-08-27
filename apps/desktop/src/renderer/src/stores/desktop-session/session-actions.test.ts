import { afterEach, describe, expect, it, vi } from "vitest"

import type { DesktopSessionView } from "@shared/session-types"
import { useDesktopSessionStore } from "../desktop-session-store"
import { beginOperation, createEmptySessionRuntime } from "./operation-state"

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

  it("projects the reopened session runtime into the legacy prompt mirror", async () => {
    const oldRuntime = {
      ...createEmptySessionRuntime(),
      pendingPromptSubmissions: {
        "input-old": {
          id: "input-old",
          sessionId: "session-old",
          content: "old prompt",
          createdAt: 1,
          phase: "failed" as const,
          placement: "transcript" as const,
          error: "old error",
        },
      },
    }
    const reopenedRuntime = beginOperation(
      {
        ...createEmptySessionRuntime(),
        pendingPromptSubmissions: {
          "input-new": {
            id: "input-new",
            sessionId: "session-new",
            content: "new prompt",
            createdAt: 2,
            phase: "submitting",
            placement: "queue",
          },
        },
        pendingPromptEdit: {
          id: "edit-new",
          sessionId: "session-new",
          sourceMessageId: "message-new",
          content: "edited prompt",
        },
        queuedPromptActions: {
          "session-new:run-new": {
            sessionId: "session-new",
            inputId: "input-queued",
            runId: "run-new",
            kind: "cancel",
            phase: "failed",
            error: "cancel error",
          },
        },
      },
      {
        id: "input-new",
        kind: "send-prompt",
        sessionId: "session-new",
        startedAt: 2,
      }
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1))
    vi.stubGlobal("window", { desktop: { sessions: { open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({
      activeSessionId: "session-old",
      sessionView: emptySessionView("session-old", 1),
      sending: false,
      sendingOperationId: null,
      pendingPromptSubmissions: oldRuntime.pendingPromptSubmissions,
      pendingPromptEdit: oldRuntime.pendingPromptEdit,
      queuedPromptActions: oldRuntime.queuedPromptActions,
      sessionRuntimes: {
        "session-old": oldRuntime,
        "session-new": reopenedRuntime,
      },
    })

    await useDesktopSessionStore.getState().openSession("session-new")

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: "session-new",
      sending: true,
      sendingOperationId: "input-new",
      pendingPromptSubmissions: {
        "input-new": expect.objectContaining({ content: "new prompt", phase: "submitting" }),
      },
      pendingPromptEdit: expect.objectContaining({ id: "edit-new" }),
      queuedPromptActions: {
        "session-new:run-new": expect.objectContaining({ phase: "failed" }),
      },
    })
    expect(useDesktopSessionStore.getState().pendingPromptSubmissions).not.toHaveProperty(
      "input-old"
    )
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

  it("does not let a late fork steal the primary subscription after A/B/A navigation", async () => {
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
    await useDesktopSessionStore.getState().openSession(source.id)
    resolveFork(forked)
    await forking

    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenNthCalledWith(1, "session-b")
    expect(open).toHaveBeenNthCalledWith(2, source.id)
    expect(useDesktopSessionStore.getState().activeSessionId).toBe(source.id)
    expect(useDesktopSessionStore.getState().sessions).toContainEqual(forked)
  })

  it("invalidates a pending fork when archiving its current primary session", async () => {
    const source = emptySessionView("session-a").session
    const archived = { ...source, status: "archived" as const }
    const forked = emptySessionView("session-fork").session
    let resolveFork!: (session: typeof forked) => void
    let resolveArchive!: (session: typeof archived) => void
    const fork = vi.fn(
      () =>
        new Promise<typeof forked>((resolve) => {
          resolveFork = resolve
        })
    )
    const archive = vi.fn(
      () =>
        new Promise<typeof archived>((resolve) => {
          resolveArchive = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId))
    vi.stubGlobal("window", { desktop: { sessions: { fork, archive, open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({ sessions: [source], activeSessionId: source.id })

    const forking = useDesktopSessionStore.getState().forkSession(source.id)
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce())
    const archiving = useDesktopSessionStore.getState().archiveSession(source.id)
    await vi.waitFor(() => expect(archive).toHaveBeenCalledWith(source.id))
    resolveFork(forked)
    await forking
    resolveArchive(archived)
    await archiving

    expect(open).not.toHaveBeenCalled()
    expect(useDesktopSessionStore.getState().activeSessionId).toBeNull()
  })

  it("invalidates a pending fork when deleting its current primary session", async () => {
    const source = emptySessionView("session-a").session
    const forked = emptySessionView("session-fork").session
    let resolveFork!: (session: typeof forked) => void
    let resolveDelete!: (sessionIds: string[]) => void
    const fork = vi.fn(
      () =>
        new Promise<typeof forked>((resolve) => {
          resolveFork = resolve
        })
    )
    const remove = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveDelete = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId))
    vi.stubGlobal("window", { desktop: { sessions: { fork, delete: remove, open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({ sessions: [source], activeSessionId: source.id })

    const forking = useDesktopSessionStore.getState().forkSession(source.id)
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce())
    const deleting = useDesktopSessionStore.getState().deleteSession(source.id)
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(source.id))
    resolveFork(forked)
    await forking
    resolveDelete([source.id])
    await deleting

    expect(open).not.toHaveBeenCalled()
    expect(useDesktopSessionStore.getState().activeSessionId).toBeNull()
  })

  it("does not restore fork navigation ownership after a current-session archive fails", async () => {
    const source = emptySessionView("session-a").session
    const forked = emptySessionView("session-fork").session
    let resolveFork!: (session: typeof forked) => void
    const fork = vi.fn(
      () =>
        new Promise<typeof forked>((resolve) => {
          resolveFork = resolve
        })
    )
    const archive = vi.fn(async () => {
      throw new Error("archive failed")
    })
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId))
    vi.stubGlobal("window", { desktop: { sessions: { fork, archive, open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({ sessions: [source], activeSessionId: source.id })

    const forking = useDesktopSessionStore.getState().forkSession(source.id)
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce())
    const archiving = useDesktopSessionStore.getState().archiveSession(source.id)
    await vi.waitFor(() => expect(archive).toHaveBeenCalledWith(source.id))
    resolveFork(forked)
    await forking
    await expect(archiving).rejects.toThrow("archive failed")

    expect(open).not.toHaveBeenCalled()
    expect(useDesktopSessionStore.getState().activeSessionId).toBe(source.id)
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

  it("records the first slash-command failure after its active open snapshot", async () => {
    const session = emptySessionView("session-active-command").session
    const snapshot = emptySessionView(session.id)
    snapshot.inputs = [
      { id: "00000000-0000-4000-8000-000000000002" },
    ] as DesktopSessionView["inputs"]
    const open = vi.fn(async () => snapshot)
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000003")
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open,
          invokeCommand: vi.fn(async () => {
            throw new Error("active command failed")
          }),
        },
      },
    })
    resetNewConversationState()

    await expect(
      useDesktopSessionStore.getState().startSession("/compact", { commandLine: "/compact" })
    ).rejects.toThrow("active command failed")

    expect(open).toHaveBeenCalledWith(session.id)
    const operations = Object.values(
      useDesktopSessionStore.getState().sessionRuntimes[session.id]?.operations ?? {}
    )
    expect(operations).toContainEqual(
      expect.objectContaining({
        kind: "invoke-command",
        phase: "failed",
        error: "active command failed",
      })
    )
    expect(operations).not.toContainEqual(
      expect.objectContaining({ kind: "create-session", phase: "failed" })
    )
    expect(useDesktopSessionStore.getState().error).toBe("active command failed")
    randomUUID.mockRestore()
  })

  it("does not invoke the first slash command when its active open fails", async () => {
    const session = emptySessionView("session-open-failure").session
    const invokeCommand = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async () => {
            throw new Error("open snapshot failed")
          }),
          invokeCommand,
        },
      },
    })
    resetNewConversationState()

    await expect(
      useDesktopSessionStore.getState().startSession("/compact", { commandLine: "/compact" })
    ).resolves.toBe(session.id)

    expect(invokeCommand).not.toHaveBeenCalled()
    expect(useDesktopSessionStore.getState().error).toBe("open snapshot failed")
    const operations = Object.values(
      useDesktopSessionStore.getState().sessionRuntimes[session.id]?.operations ?? {}
    )
    expect(operations).toContainEqual(
      expect.objectContaining({ kind: "create-session", phase: "acknowledged" })
    )
    expect(operations).not.toContainEqual(expect.objectContaining({ kind: "invoke-command" }))
  })

  it("runs a cancelled active slash command in the background without reclaiming primary", async () => {
    const session = emptySessionView("session-command").session
    let resolveCreatedOpen!: (view: DesktopSessionView) => void
    const open = vi.fn((sessionId: string) => {
      if (sessionId === session.id) {
        return new Promise<DesktopSessionView>((resolve) => {
          resolveCreatedOpen = resolve
        })
      }
      return Promise.resolve(emptySessionView(sessionId, 1))
    })
    const invokeCommand = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open,
          invokeCommand,
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore
      .getState()
      .startSession("/compact", { commandLine: "/compact" })
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(session.id))
    await useDesktopSessionStore.getState().openSession("session-b")
    resolveCreatedOpen(emptySessionView(session.id))
    await starting

    expect(invokeCommand).toHaveBeenCalledWith({ sessionId: session.id, line: "/compact" })
    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: "session-b",
      sessionView: { session: { id: "session-b" } },
    })
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
