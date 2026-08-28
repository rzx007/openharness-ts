// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopAttachmentSessionPart, DesktopSessionMessage } from "@shared/session-types"
import { MessageBlock } from "./message-block"
import { attachmentRoutingMessage, MessageAttachment } from "./message-attachment"

describe("MessageAttachment", () => {
  let container: HTMLDivElement
  let root: Root
  let readPreview: ReturnType<typeof vi.fn>
  let open: ReturnType<typeof vi.fn>
  let saveAs: ReturnType<typeof vi.fn>
  let createObjectURL: ReturnType<typeof vi.fn>
  let revokeObjectURL: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    readPreview = vi.fn(async ({ assetId }: { assetId: string }) => ({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      mediaType: "image/png",
      assetId,
    }))
    open = vi.fn(async () => undefined)
    saveAs = vi.fn(async () => undefined)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { attachments: { readPreview, open, saveAs } },
    })
    createObjectURL = vi.fn(
      (blob: Blob) => `blob:${blob.size}:${createObjectURL.mock.calls.length}`
    )
    revokeObjectURL = vi.fn()
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("loads safe bitmap previews and revokes each Blob URL on asset changes and unmount", async () => {
    await act(async () => root.render(createElement(MessageAttachment, { part: imagePart("a") })))

    expect(readPreview).toHaveBeenCalledWith({ assetId: "asset-a" })
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:3:1")

    await act(async () => root.render(createElement(MessageAttachment, { part: imagePart("b") })))
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:3:1")
    expect(readPreview).toHaveBeenCalledWith({ assetId: "asset-b" })

    act(() => root.unmount())
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:3:2")
    root = createRoot(container)
  })

  it("never previews active content and renders the file name as text", async () => {
    const svg = imagePart("svg", "image/svg+xml", "<img onerror=alert(1)>.svg")
    await act(async () => root.render(createElement(MessageAttachment, { part: svg })))

    expect(readPreview).not.toHaveBeenCalled()
    expect(container.textContent).toContain("<img onerror=alert(1)>.svg")
    expect(container.querySelector("img")).toBeNull()
  })

  it("rejects active content returned by the preview API even when the stored type looks safe", async () => {
    readPreview.mockResolvedValueOnce({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      mediaType: "image/svg+xml",
      assetId: "asset-a",
    })
    await act(async () => root.render(createElement(MessageAttachment, { part: imagePart("a") })))

    expect(readPreview).toHaveBeenCalledWith({ assetId: "asset-a" })
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(container.querySelector("img")).toBeNull()
  })

  it("falls back to an icon when preview loading fails and exposes safe open/save actions", async () => {
    readPreview.mockRejectedValueOnce(new Error("preview failed"))
    await act(async () => root.render(createElement(MessageAttachment, { part: imagePart("a") })))

    expect(container.querySelector("img")).toBeNull()
    const buttons = [...container.querySelectorAll("button")]
    await act(async () =>
      buttons.find((button) => button.getAttribute("aria-label") === "打开 a.png")?.click()
    )
    await act(async () =>
      buttons.find((button) => button.getAttribute("aria-label") === "另存为 a.png")?.click()
    )
    expect(open).toHaveBeenCalledWith({ assetId: "asset-a" })
    expect(saveAs).toHaveBeenCalledWith({ assetId: "asset-a" })
  })

  it("falls back to an icon when the browser cannot decode the preview", async () => {
    await act(async () => root.render(createElement(MessageAttachment, { part: imagePart("a") })))

    const image = container.querySelector("img")
    expect(image).not.toBeNull()
    await act(async () => image?.dispatchEvent(new Event("error")))

    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("keeps original cards read-only while editing a pure-attachment message", async () => {
    const onEdit = vi.fn()
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
    await act(async () =>
      root.render(
        createElement(MessageBlock, {
          message,
          parts: [imagePart("svg", "image/svg+xml", "diagram.svg")],
          streaming: false,
          userActions: { canEdit: true, onEdit },
          onOpenFile: () => undefined,
          canOpenReview: false,
          onOpenReview: () => undefined,
          onOpenTerminal: () => undefined,
        })
      )
    )

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="重新编辑"]')?.click()
    )
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("")
    expect(container.textContent).toContain("diagram.svg")
    expect(container.querySelector('[aria-label^="移除附件"]')).toBeNull()
    expect(container.querySelector('[aria-label="添加附件"]')).toBeNull()

    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("重新生成"))
        ?.click()
    )
    expect(onEdit).toHaveBeenCalledWith("")
  })
})

describe("attachmentRoutingMessage", () => {
  it("turns stable routing codes into actionable Chinese messages", () => {
    expect(attachmentRoutingMessage("attachment_model_capability_unknown")).toBe(
      "当前模型没有声明图片能力，请切换支持图片的模型后重试。"
    )
    expect(attachmentRoutingMessage("attachment_intent_unavailable")).toBe(
      "当前阶段还不能执行 OCR 或文档处理，请移除附件处理方式后重试。"
    )
  })

  it("does not expose unknown backend text directly", () => {
    expect(attachmentRoutingMessage("unexpected_internal_error")).toBe(
      "附件处理失败，请检查附件和模型设置后重试。"
    )
  })
})

function imagePart(
  suffix: string,
  mediaType = "image/png",
  displayName = `${suffix}.png`
): DesktopAttachmentSessionPart {
  return {
    id: `part-${suffix}`,
    sessionId: "session-1",
    messageId: "message-1",
    seq: 0,
    type: "attachment",
    status: "completed",
    assetId: `asset-${suffix}`,
    intent: "auto",
    displayName,
    mediaType,
    sizeBytes: 3,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}
