import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { createEmptySessionRuntime } from "@renderer/stores/desktop-session/operation-state"
import {
  selectActiveSessionComposerError,
  selectAppOperationError,
  selectNewConversationError,
  selectProjectOperationError,
} from "@renderer/stores/desktop-session/selectors"
import type { DesktopOperation, DesktopSessionState } from "@renderer/stores/desktop-session/types"
import { ScopedOperationError } from "./scoped-operation-errors"

function failedOperation(
  id: string,
  kind: DesktopOperation["kind"],
  sessionId: string | null,
  error: string
): DesktopOperation {
  return {
    id,
    kind,
    phase: "failed",
    sessionId,
    startedAt: 1,
    finishedAt: 2,
    error,
  }
}

function runtimeWith(operation: DesktopOperation): DesktopSessionState["newConversationRuntime"] {
  return {
    ...createEmptySessionRuntime(),
    operations: { [operation.id]: operation },
  }
}

function stateWith(overrides: Partial<DesktopSessionState>): DesktopSessionState {
  return {
    activeSessionId: null,
    newConversationRuntime: createEmptySessionRuntime(),
    sessionRuntimes: {},
    appOperations: {},
    projectOperations: {},
    ...overrides,
  } as DesktopSessionState
}

function renderConversationError(state: DesktopSessionState): string {
  const error = state.activeSessionId
    ? selectActiveSessionComposerError(state)
    : selectNewConversationError(state)
  return renderToStaticMarkup(createElement(ScopedOperationError, { error }))
}

function renderProjectError(state: DesktopSessionState): string {
  return renderToStaticMarkup(
    createElement(ScopedOperationError, {
      error: selectProjectOperationError(state, state.selectedProject?.id ?? null),
    })
  )
}

function renderAppError(state: DesktopSessionState): string {
  return renderToStaticMarkup(
    createElement(ScopedOperationError, { error: selectAppOperationError(state) })
  )
}

describe("scoped operation errors", () => {
  it.each([
    ["open-session", "无法打开会话"],
    ["invoke-command", "命令执行失败"],
  ] as const)("shows a failed active %s operation", (kind, message) => {
    const state = stateWith({
      activeSessionId: "session-a",
      sessionRuntimes: {
        "session-a": runtimeWith(failedOperation("operation-a", kind, "session-a", message)),
      },
    })

    expect(renderConversationError(state)).toContain(message)
  })

  it("shows a new-conversation create failure without leaking an old session error", () => {
    const state = stateWith({
      activeSessionId: null,
      newConversationRuntime: runtimeWith(
        failedOperation("create-new", "create-session", null, "无法创建新会话")
      ),
      sessionRuntimes: {
        "session-old": runtimeWith(
          failedOperation("command-old", "invoke-command", "session-old", "旧会话命令失败")
        ),
      },
    })

    const html = renderConversationError(state)

    expect(html).toContain("无法创建新会话")
    expect(html).not.toContain("旧会话命令失败")
  })

  it("shows only the selected project's operation error", () => {
    const projectAState = stateWith({
      selectedProject: {
        id: "project-a",
        name: "项目 A",
        path: "D:\\project-a",
        lastOpenedAt: 1,
        available: true,
      },
      projectOperations: {
        "project-a": {
          "project-a-operation": {
            ...failedOperation("project-a-operation", "project-action", null, "项目 A 操作失败"),
            projectId: "project-a",
          },
        },
        "project-b": {
          "project-b-operation": {
            ...failedOperation("project-b-operation", "project-action", null, "项目 B 操作失败"),
            projectId: "project-b",
          },
        },
      },
    })

    expect(renderProjectError(projectAState)).toContain("项目 A 操作失败")

    const projectBState = {
      ...projectAState,
      selectedProject: {
        id: "project-b",
        name: "项目 B",
        path: "D:\\project-b",
        lastOpenedAt: 2,
        available: true,
      },
    }

    const html = renderProjectError(projectBState)
    expect(html).toContain("项目 B 操作失败")
    expect(html).not.toContain("项目 A 操作失败")
  })

  it("shows a bootstrap error from the app scope", () => {
    const state = stateWith({
      appOperations: {
        initialize: {
          ...failedOperation("initialize", "project-action", null, "Desktop 初始化失败"),
          target: "initialize",
        },
      },
    })

    expect(renderAppError(state)).toContain("Desktop 初始化失败")
  })

  it("does not duplicate a failed prompt submission in the composer error owner", () => {
    const submissionError = "普通消息发送失败"
    const state = stateWith({
      activeSessionId: "session-a",
      sessionRuntimes: {
        "session-a": {
          ...runtimeWith(failedOperation("prompt-a", "send-prompt", "session-a", submissionError)),
          pendingPromptSubmissions: {
            "prompt-a": {
              id: "prompt-a",
              sessionId: "session-a",
              content: "需要重试的消息",
              createdAt: 1,
              phase: "failed",
              placement: "queue",
              error: submissionError,
            },
          },
        },
      },
    })

    expect(renderConversationError(state)).not.toContain(submissionError)
  })
})
