import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopSessionView } from "@shared/session-types"
import { createEmptySessionRuntime } from "./operation-state"
import { createPromptActions } from "./prompt-actions"
import { createQueuedPromptActions } from "./queued-prompt-actions"
import { emptySessionView, resetDesktopSessionStore, sessionRuntime } from "./store-test-fixtures"
import { useDesktopSessionStore } from "./store"
import { selectActiveSessionQueuedPromptActions, selectSessionSending } from "./selectors"
import type { DesktopSessionRuntime } from "./types"

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
  beforeEach(() => {
    resetDesktopSessionStore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps the session runtime pending until SSE confirms the submitted input", async () => {
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
      sessionRuntimes: { "session-1": createEmptySessionRuntime() },
    })

    const request = useDesktopSessionStore.getState().sendMessage("pending")
    const inputId = sendPrompt.mock.calls[0]![0].id
    useDesktopSessionStore.getState().applySessionUpdate({
      ...viewContainingInput("session-1", inputId, 1),
      inputs: [],
    })

    expect(useDesktopSessionStore.getState().sessionRuntimes["session-1"]).toMatchObject({
      operations: {
        [inputId]: expect.objectContaining({ phase: "pending" }),
      },
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

    expect(useDesktopSessionStore.getState().sessionRuntimes["session-1"]).toMatchObject({
      operations: {},
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

    expect(useDesktopSessionStore.getState().sessionRuntimes["session-1"]!.operations).toEqual({})
  })
})
function onlyPendingPromptSubmission(
  sessionId?: string
): DesktopSessionRuntime["pendingPromptSubmissions"][string] {
  const currentSessionId = sessionId ?? useDesktopSessionStore.getState().activeSessionId
  const submissions = Object.values(
    currentSessionId
      ? (
          useDesktopSessionStore.getState().sessionRuntimes[currentSessionId] ??
          createEmptySessionRuntime()
        ).pendingPromptSubmissions
      : {}
  )
  expect(submissions).toHaveLength(1)
  return submissions[0]!
}

describe("desktop session store prompt intent boundaries", () => {
  beforeEach(() => {
    useDesktopSessionStore.setState({
      activeSessionId: null,
      sessionView: null,
      newConversationRuntime: createEmptySessionRuntime(),
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
    })

    await useDesktopSessionStore.getState().sendMessage("/compact", { commandLine: "/compact" })

    expect(invokeCommand).toHaveBeenCalledWith({ sessionId: "session-1", line: "/compact" })
    expect(sessionRuntime("session-1").pendingPromptSubmissions).toEqual({})
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
    })

    const oldRequest = useDesktopSessionStore.getState().sendMessage("old request")
    useDesktopSessionStore.setState({ activeSessionId: "session-new" })
    const newRequest = useDesktopSessionStore.getState().sendMessage("new request")

    resolveOld()
    await oldRequest
    expect(useDesktopSessionStore.getState().activeSessionId).toBe("session-new")
    expect(selectSessionSending(useDesktopSessionStore.getState(), "session-new")).toBe(true)

    resolveNew()
    await newRequest
    expect(selectSessionSending(useDesktopSessionStore.getState(), "session-new")).toBe(false)
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
    })

    await useDesktopSessionStore.getState().sendMessage("first request")
    await useDesktopSessionStore.getState().sendMessage("second request")

    const firstCall = sendPrompt.mock.calls[0]!
    const secondCall = sendPrompt.mock.calls[1]!
    expect(Object.values(sessionRuntime("session-1").pendingPromptSubmissions)).toHaveLength(2)
    expect(sessionRuntime("session-1").pendingPromptSubmissions[firstCall[0].id]).toMatchObject({
      placement: "transcript",
    })
    expect(sessionRuntime("session-1").pendingPromptSubmissions[secondCall[0].id]).toMatchObject({
      placement: "queue",
    })

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

    expect(Object.keys(sessionRuntime("session-1").pendingPromptSubmissions)).toEqual([
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
    })
    rejectSend(new Error("response lost"))

    await expect(request).resolves.toBeUndefined()
    expect(sessionRuntime("session-1").pendingPromptSubmissions).toEqual({})
  })

  it("reuses the same input id when an uncertain send is retried", async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(undefined)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
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
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })

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
    })

    await expect(
      useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")
    ).rejects.toThrow("response lost")
    await useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")

    expect(editLatestPrompt).toHaveBeenCalledTimes(2)
    expect(editLatestPrompt.mock.calls[1]?.[0].id).toBe(editLatestPrompt.mock.calls[0]?.[0].id)
    expect(sessionRuntime("session-1").pendingPromptEdit).toBeNull()
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
    })

    const editing = useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")
    useDesktopSessionStore.setState({
      activeSessionId: "session-2",
    })
    const sending = useDesktopSessionStore.getState().sendMessage("new session request")

    resolveEdit()
    await editing
    expect(useDesktopSessionStore.getState().activeSessionId).toBe("session-2")
    expect(selectSessionSending(useDesktopSessionStore.getState(), "session-2")).toBe(true)

    resolveSend()
    await sending
    expect(selectSessionSending(useDesktopSessionStore.getState(), "session-2")).toBe(false)
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
    expect(Object.values(sessionRuntime("session-1").queuedPromptActions)).toEqual([
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
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")

    expect(sessionRuntime("session-1").queuedPromptActions).toMatchObject({
      "session-1:run-queued": {
        sessionId: "session-1",
        runId: "run-queued",
        kind: "promote",
        phase: "pending",
      },
    })

    resolvePromote()
    await request

    expect(sessionRuntime("session-1").queuedPromptActions).toMatchObject({
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
    })
    rejectPromote(new Error("response lost"))
    await request

    expect(sessionRuntime("session-1").queuedPromptActions).toEqual({})
  })

  it("keeps an action failure on its queued run with a readable message", async () => {
    const promoteQueuedPrompt = vi.fn(async () => {
      throw new Error("Active run changed")
    })
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
    })

    await useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")

    expect(sessionRuntime("session-1").queuedPromptActions).toMatchObject({
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
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")
    useDesktopSessionStore.setState({ activeSessionId: "session-2" })
    rejectPromote(new Error("Active run changed"))
    await request

    expect(selectActiveSessionQueuedPromptActions(useDesktopSessionStore.getState())).toEqual({})
    expect(
      useDesktopSessionStore.getState().sessionRuntimes["session-1"]?.queuedPromptActions
    ).toMatchObject({
      "session-1:run-queued": { phase: "failed" },
    })
  })

  it("clears an acknowledged queue action when SSE reports the run terminal", () => {
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
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

    expect(sessionRuntime("session-1").queuedPromptActions).toEqual({})
  })
})
