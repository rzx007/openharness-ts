import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"
import { MessageBlock } from "./message-block"
import { visibleTranscriptParts } from "./transcript-visibility"

describe("visibleTranscriptParts", () => {
  it("renders selected skill metadata as a compact capsule above the user task", () => {
    const message: DesktopSessionMessage = {
      id: "message-skill",
      sessionId: "session-1",
      seq: 1,
      role: "user",
      inputId: "input-skill",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const html = renderToStaticMarkup(
      createElement(MessageBlock, {
        message,
        parts: [
          {
            id: "text-skill",
            sessionId: "session-1",
            messageId: "message-skill",
            seq: 0,
            type: "text",
            status: "completed",
            text: "画一下系统架构",
            metadata: {
              skillInvocation: {
                name: "archify",
                displayName: "Archify",
                source: "project",
                invocationSource: "slash",
              },
            },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        streaming: false,
        onOpenFile: () => undefined,
        canOpenReview: false,
        onOpenReview: () => undefined,
        onOpenTerminal: () => undefined,
      })
    )

    expect(html).toContain('aria-label="使用的技能"')
    expect(html).toContain("Archify")
    expect(html).toContain("项目")
    expect(html).toContain("画一下系统架构")
    expect(html).not.toContain("SKILL.md")
  })

  it("removes reasoning from a read-only child replay without hiding other activity", () => {
    const parts = [
      part("reasoning", "private reasoning"),
      part("text", "visible answer"),
      part("tool", undefined, "read_file"),
      part("tool_result", "visible result"),
      part("error", "visible failure"),
    ]

    const visible = visibleTranscriptParts(parts, false)

    expect(visible.map((item) => item.type)).toEqual(["text", "tool", "tool_result", "error"])
    expect(visible.some((item) => item.text === "private reasoning")).toBe(false)
  })

  it("keeps reasoning in the normal conversation transcript", () => {
    const parts = [part("reasoning", "normal reasoning")]

    expect(visibleTranscriptParts(parts, true)).toBe(parts)
  })

  it("renders attachments above user text and hides internal transformation parts", () => {
    const message: DesktopSessionMessage = {
      id: "message-1",
      sessionId: "session-1",
      seq: 1,
      role: "user",
      inputId: "input-1",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const html = renderToStaticMarkup(
      createElement(MessageBlock, {
        message,
        parts: [
          {
            id: "text-1",
            sessionId: "session-1",
            messageId: "message-1",
            seq: 0,
            type: "text",
            status: "completed",
            text: "解析一下",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "attachment-1",
            sessionId: "session-1",
            messageId: "message-1",
            seq: 1,
            type: "attachment",
            status: "completed",
            assetId: "asset-1",
            intent: "auto",
            displayName: "evidence.pdf",
            mediaType: "application/pdf",
            sizeBytes: 10,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "transformation-1",
            sessionId: "session-1",
            messageId: "message-1",
            seq: 2,
            type: "transformation",
            status: "completed",
            assetId: "asset-1",
            kind: "direct",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        streaming: false,
        userActions: { canEdit: true, onEdit: () => undefined },
        onOpenFile: () => undefined,
        canOpenReview: false,
        onOpenReview: () => undefined,
        onOpenTerminal: () => undefined,
      })
    )

    expect(html).toContain("evidence.pdf")
    expect(html.indexOf("evidence.pdf")).toBeLessThan(html.indexOf("解析一下"))
    expect(html).not.toContain("附件已处理")
    expect(html).not.toContain("已作为原生图片输入")
    expect(html).toContain('aria-label="重新编辑"')
    expect(html).not.toContain("已发送消息")
  })

  it("removes internal transformation parts from the visible transcript", () => {
    const transformation = {
      id: "transformation-1",
      sessionId: "session-1",
      messageId: "message-1",
      seq: 1,
      type: "transformation" as const,
      status: "completed" as const,
      assetId: "asset-1",
      kind: "direct" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }

    expect(visibleTranscriptParts([transformation], true)).toEqual([])
    expect(visibleTranscriptParts([transformation], false)).toEqual([])
  })
})

function part(
  type: "text" | "reasoning" | "tool" | "tool_result" | "error" | "log",
  text?: string,
  toolName?: string
): DesktopSessionPart {
  return {
    id: `${type}-part`,
    sessionId: "child-session",
    messageId: "message",
    seq: 1,
    type,
    status: "completed",
    ...(text ? { text } : {}),
    ...(toolName ? { toolName } : {}),
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}
