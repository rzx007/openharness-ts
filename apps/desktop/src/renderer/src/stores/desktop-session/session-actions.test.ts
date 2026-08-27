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
