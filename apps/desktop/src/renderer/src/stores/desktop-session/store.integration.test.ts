import { beforeEach, describe, expect, it, vi } from "vitest"

import { emptySessionView, resetDesktopSessionStore } from "./store-test-fixtures"
import { useDesktopSessionStore } from "./store"

beforeEach(() => {
  resetDesktopSessionStore()
  vi.unstubAllGlobals()
})

describe("desktop session store composition", () => {
  it("provides every action from the composed store", () => {
    const state = useDesktopSessionStore.getState()

    expect(state.initialize).toEqual(expect.any(Function))
    expect(state.selectProject).toEqual(expect.any(Function))
    expect(state.openSession).toEqual(expect.any(Function))
    expect(state.sendMessage).toEqual(expect.any(Function))
    expect(state.promoteQueuedPrompt).toEqual(expect.any(Function))
    expect(state.applySessionUpdate).toEqual(expect.any(Function))
  })
})

describe("desktop session store integration races", () => {
  it("queues a rapid second send before the first SSE confirmation", async () => {
    const sendPrompt = vi.fn<
      (input: { id: string; sessionId: string; content: string }) => Promise<void>
    >(async () => undefined)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
    })

    await useDesktopSessionStore.getState().sendMessage("first")
    await useDesktopSessionStore.getState().sendMessage("second")

    const [firstCall, secondCall] = sendPrompt.mock.calls
    const submissions =
      useDesktopSessionStore.getState().sessionRuntimes["session-1"]?.pendingPromptSubmissions
    expect(submissions?.[firstCall![0].id]).toMatchObject({ placement: "transcript" })
    expect(submissions?.[secondCall![0].id]).toMatchObject({ placement: "queue" })
  })

  it("keeps an SSE-confirmed send successful when its IPC response arrives as an error", async () => {
    let rejectSend!: (error: Error) => void
    const sendPrompt = vi.fn<
      (input: { id: string; sessionId: string; content: string }) => Promise<void>
    >(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
    })

    const request = useDesktopSessionStore.getState().sendMessage("confirmed")
    const inputId = sendPrompt.mock.calls[0]![0].id
    const confirmedView = emptySessionView("session-1", 1)
    confirmedView.inputs = [
      {
        id: inputId,
        sessionId: "session-1",
        seq: 1,
        delivery: "queue",
        content: "confirmed",
        metadata: {},
        createdAt: 1,
      },
    ]
    useDesktopSessionStore.getState().applySessionUpdate(confirmedView)
    rejectSend(new Error("response lost"))

    await expect(request).resolves.toBeUndefined()
    expect(
      useDesktopSessionStore.getState().sessionRuntimes["session-1"]?.pendingPromptSubmissions
    ).toEqual({})
  })

  it("keeps a background session failure out of the active session error scope", async () => {
    let rejectSend!: (error: Error) => void
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({ activeSessionId: "session-old" })

    const request = useDesktopSessionStore.getState().sendMessage("old request")
    useDesktopSessionStore.setState({ activeSessionId: "session-new" })
    rejectSend(new Error("old request failed"))

    await expect(request).rejects.toThrow("old request failed")
    expect(
      Object.values(
        useDesktopSessionStore.getState().sessionRuntimes["session-old"]
          ?.pendingPromptSubmissions ?? {}
      )
    ).toContainEqual(expect.objectContaining({ phase: "failed", error: "old request failed" }))
    expect(useDesktopSessionStore.getState().sessionRuntimes["session-new"]).toBeUndefined()
  })
})
