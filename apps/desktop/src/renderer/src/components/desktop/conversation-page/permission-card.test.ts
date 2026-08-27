import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { PermissionCard } from "./message-block"

describe("PermissionCard", () => {
  it("disables both decisions and shows the scoped error while a reply is pending", () => {
    const html = renderToStaticMarkup(
      createElement(PermissionCard, {
        permission: {
          id: "permission-1",
          sessionId: "session-1",
          toolName: "shell",
          payload: {},
          status: "pending",
          createdAt: 1,
          updatedAt: 1,
        },
        replyPending: true,
        replyError: "授权回复失败",
        onReply: vi.fn(),
      })
    )

    expect(html).toContain("正在提交")
    expect(html).toContain("授权回复失败")
    expect(html).toMatch(/<button[^>]*disabled[^>]*>拒绝<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled[^>]*>正在提交<\/button>/)
  })
})
