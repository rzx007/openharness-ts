import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { PendingPromptQueue } from "./pending-prompt-queue"

describe("PendingPromptQueue", () => {
  it("shows a local submission before the session stream confirms it", () => {
    const html = renderToStaticMarkup(
      createElement(PendingPromptQueue, {
        prompts: [],
        activeRunId: "run-active",
        actionId: null,
        localSubmission: {
          id: "input-local",
          sessionId: "session-1",
          content: "new request",
          phase: "submitting",
        },
        onPromote: vi.fn(),
        onCancel: vi.fn(),
      })
    )

    expect(html).toContain("new request")
    expect(html).toContain("正在发送")
  })
})
