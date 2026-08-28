// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import { ComposerAttachments } from "./composer-attachments"

describe("ComposerAttachments preview", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        attachments: {
          readPreview: vi.fn(async () => ({
            bytes: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
            mediaType: "image/jpeg",
          })),
        },
      },
    })
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => `blob:${blob.type}:${blob.size}`),
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("uses exact preview bytes and falls back to the file icon after an image decode error", async () => {
    await act(async () =>
      root.render(
        createElement(ComposerAttachments, {
          attachments: [readyImage],
          onCancel: vi.fn(),
          onRetry: vi.fn(),
          onRemove: vi.fn(),
        })
      )
    )

    const image = container.querySelector("img")
    expect(image?.getAttribute("src")).toBe("blob:image/jpeg:3")
    await act(async () => image?.dispatchEvent(new Event("error")))

    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("svg")).not.toBeNull()
  })
})

const readyImage: DesktopAttachmentDraft = {
  draftId: "draft-image",
  taskId: "task-image",
  displayName: "runtime-map.jpeg",
  declaredMediaType: "image/jpeg",
  sizeBytes: 648_400,
  status: "ready",
  bytesUploaded: 648_400,
  progress: 1,
  assetId: "asset-image",
  mediaType: "image/jpeg",
}
