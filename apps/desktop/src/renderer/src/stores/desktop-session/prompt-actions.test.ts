import { afterEach, describe, expect, it, vi } from "vitest"

import type { DesktopSessionView } from "@shared/session-types"
import { createEmptySessionRuntime } from "./operation-state"
import { createPromptActions } from "./prompt-actions"
import { createQueuedPromptActions } from "./queued-prompt-actions"
import { useDesktopSessionStore } from "../desktop-session-store"

function viewContainingInput(
  sessionId: string,
  inputId: string,
  cursor: number
): DesktopSessionView {
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
      updatedAt: cursor,
    },
    inputs: [
      {
        id: inputId,
        sessionId,
        seq: 1,
        delivery: "queue",
        content: "confirmed",
        metadata: {},
        createdAt: 1,
      },
    ],
    messages: [],
    parts: [],
    runs: [],
    tasks: [],
    permissions: [],
  }
}

describe("prompt actions session runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps the legacy composer mirror pending until SSE confirms the submitted input", async () => {
    let resolveSend!: () => void
    const sendPrompt = vi.fn<
      (input: { id: string; sessionId: string; content: string }) => Promise<void>
    >(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: null,
      sending: false,
      sendingOperationId: null,
      pendingPromptSubmissions: {},
      pendingPromptEdit: null,
      queuedPromptActions: {},
      sessionRuntimes: { "session-1": createEmptySessionRuntime() },
    })

    const request = useDesktopSessionStore.getState().sendMessage("pending")
    const inputId = sendPrompt.mock.calls[0]![0].id
    useDesktopSessionStore.getState().applySessionUpdate({
      ...viewContainingInput("session-1", inputId, 1),
      inputs: [],
    })

    expect(useDesktopSessionStore.getState()).toMatchObject({
      sending: true,
      sendingOperationId: inputId,
      pendingPromptSubmissions: {
        [inputId]: expect.objectContaining({ phase: "submitting", content: "pending" }),
      },
    })

    resolveSend()
    await request
  })

  it("keeps an old session send from settling the new session runtime", async () => {
    let resolveOld!: () => void
    let resolveNew!: () => void
    const sendPrompt = vi.fn(
      ({ content }: { content: string }) =>
        new Promise<void>((resolve) => {
          if (content === "old") resolveOld = resolve
          else resolveNew = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-old",
      sessionView: null,
      sessionRuntimes: {
        "session-old": createEmptySessionRuntime(),
        "session-new": createEmptySessionRuntime(),
      },
    })

    const oldRequest = useDesktopSessionStore.getState().sendMessage("old")
    useDesktopSessionStore.setState({ activeSessionId: "session-new" })
    const newRequest = useDesktopSessionStore.getState().sendMessage("new")

    resolveOld()
    await oldRequest

    const runtimes = useDesktopSessionStore.getState().sessionRuntimes
    expect(Object.values(runtimes["session-old"]!.operations)).toHaveLength(1)
    expect(Object.values(runtimes["session-new"]!.operations)).toHaveLength(1)

    resolveNew()
    await newRequest
  })

  it("treats an SSE-confirmed input as success when IPC rejects later", async () => {
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
      sessionView: null,
      sessionRuntimes: { "session-1": createEmptySessionRuntime() },
    })

    const request = useDesktopSessionStore.getState().sendMessage("confirmed")
    const inputId = sendPrompt.mock.calls[0]![0].id
    useDesktopSessionStore
      .getState()
      .applySessionUpdate(viewContainingInput("session-1", inputId, 1))

    expect(useDesktopSessionStore.getState()).toMatchObject({
      sending: false,
      sendingOperationId: null,
      pendingPromptSubmissions: {},
    })
    rejectSend(new Error("response lost"))

    await expect(request).resolves.toBeUndefined()
    const runtime = useDesktopSessionStore.getState().sessionRuntimes["session-1"]!
    expect(runtime.pendingPromptSubmissions).toEqual({})
    expect(runtime.operations).toEqual({})
  })

  it("assigns command operations to the invoking session without creating a prompt submission", async () => {
    let resolveCommand!: () => void
    const invokeCommand = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCommand = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { invokeCommand } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionRuntimes: { "session-1": createEmptySessionRuntime() },
    })

    const request = useDesktopSessionStore
      .getState()
      .sendMessage("/compact", { commandLine: "/compact" })

    const runtime = useDesktopSessionStore.getState().sessionRuntimes["session-1"]!
    expect(runtime.pendingPromptSubmissions).toEqual({})
    expect(Object.values(runtime.operations)).toEqual([
      expect.objectContaining({ kind: "invoke-command", sessionId: "session-1", phase: "pending" }),
    ])
    expect(createPromptActions).toBeTypeOf("function")

    resolveCommand()
    await request
    expect(useDesktopSessionStore.getState().sessionRuntimes["session-1"]!.operations).toEqual({})
  })

  it("reconciles a queued action and its stable operation key when SSE reaches its run", async () => {
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
      sessionView: null,
      sessionRuntimes: { "session-1": createEmptySessionRuntime() },
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-1", "run-1", "run-active")
    useDesktopSessionStore.getState().applySessionUpdate({
      ...viewContainingInput("session-1", "input-1", 1),
      runs: [
        {
          id: "run-1",
          sessionId: "session-1",
          inputId: "input-1",
          status: "interrupted",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    const runtime = useDesktopSessionStore.getState().sessionRuntimes["session-1"]!
    expect(runtime.queuedPromptActions).toEqual({})
    expect(runtime.operations).toEqual({})
    expect(createQueuedPromptActions).toBeTypeOf("function")

    rejectPromote(new Error("response lost"))
    await expect(request).resolves.toBeUndefined()
  })

  it("does not surface a late interrupt failure after SSE confirms the targeted run", async () => {
    let rejectInterrupt!: (error: Error) => void
    const interrupt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInterrupt = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { interrupt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: {
        ...viewContainingInput("session-1", "input-1", 1),
        runs: [
          {
            id: "run-1",
            sessionId: "session-1",
            inputId: "input-1",
            status: "running",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      sessionRuntimes: { "session-1": createEmptySessionRuntime() },
      error: null,
    })

    const request = useDesktopSessionStore.getState().interrupt()
    useDesktopSessionStore.getState().applySessionUpdate({
      ...viewContainingInput("session-1", "input-1", 2),
      runs: [
        {
          id: "run-1",
          sessionId: "session-1",
          inputId: "input-1",
          status: "interrupted",
          metadata: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    rejectInterrupt(new Error("response lost"))
    await expect(request).resolves.toBeUndefined()

    expect(useDesktopSessionStore.getState().error).toBeNull()
    expect(useDesktopSessionStore.getState().sessionRuntimes["session-1"]!.operations).toEqual({})
  })
})
