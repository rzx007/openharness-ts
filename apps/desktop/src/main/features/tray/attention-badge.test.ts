import { describe, expect, it, vi } from "vitest"

import { createAttentionBadgeController } from "./attention-badge"

describe("attention badge", () => {
  it("increments only while the main window is unfocused", () => {
    const setOverlayIcon = vi.fn()
    const createFromBitmap = vi.fn(() => ({ kind: "badge-icon" }))
    const controller = createAttentionBadgeController({
      platform: "win32",
      setBadgeCount: vi.fn(),
      createFromBitmap,
    })
    const window = {
      isDestroyed: () => false,
      isFocused: () => false,
      setOverlayIcon,
    }

    controller.noteUnfocusedAttention(() => window)
    controller.noteUnfocusedAttention(() => window)

    expect(controller.getUnreadCount()).toBe(2)
    expect(createFromBitmap).toHaveBeenLastCalledWith(expect.any(Buffer), {
      width: 16,
      height: 16,
      scaleFactor: 1,
    })
    expect(setOverlayIcon).toHaveBeenLastCalledWith({ kind: "badge-icon" }, "2 条未读通知")
  })

  it("does not increment while the main window is focused", () => {
    const setBadgeCount = vi.fn()
    const setOverlayIcon = vi.fn()
    const controller = createAttentionBadgeController({
      platform: "win32",
      setBadgeCount,
      createFromBitmap: vi.fn(() => ({ kind: "badge-icon" })),
    })

    controller.noteUnfocusedAttention(() => ({
      isDestroyed: () => false,
      isFocused: () => true,
      setOverlayIcon,
    }))

    expect(controller.getUnreadCount()).toBe(0)
    expect(setBadgeCount).not.toHaveBeenCalled()
    expect(setOverlayIcon).not.toHaveBeenCalled()
  })

  it("clears the unread count and platform badges when focused again", () => {
    const setBadgeCount = vi.fn(() => true)
    const setOverlayIcon = vi.fn()
    const controller = createAttentionBadgeController({
      platform: "win32",
      setBadgeCount,
      createFromBitmap: vi.fn(() => ({ kind: "badge-icon" })),
    })
    const window = {
      isDestroyed: () => false,
      isFocused: () => false,
      setOverlayIcon,
    }
    controller.noteUnfocusedAttention(() => window)

    controller.clearAttention(() => window)

    expect(controller.getUnreadCount()).toBe(0)
    expect(setBadgeCount).not.toHaveBeenCalled()
    expect(setOverlayIcon).toHaveBeenLastCalledWith(null, "")
  })

  it("does not call the Windows overlay API when Linux rejects native badges", () => {
    const setBadgeCount = vi.fn(() => false)
    const setOverlayIcon = vi.fn()
    const controller = createAttentionBadgeController({
      platform: "linux",
      setBadgeCount,
      createFromBitmap: vi.fn(() => ({ kind: "badge-icon" })),
    })

    controller.noteUnfocusedAttention(() => ({
      isDestroyed: () => false,
      isFocused: () => false,
      setOverlayIcon,
    }))

    expect(controller.getUnreadCount()).toBe(1)
    expect(setBadgeCount).toHaveBeenCalledWith(1)
    expect(setOverlayIcon).not.toHaveBeenCalled()
  })

  it("renders 9+ after the unread count exceeds nine", () => {
    const bitmaps: Buffer[] = []
    const controller = createAttentionBadgeController({
      platform: "win32",
      setBadgeCount: vi.fn(),
      createFromBitmap: vi.fn((bitmap) => {
        bitmaps.push(Buffer.from(bitmap))
        return { kind: "badge-icon" }
      }),
    })
    const setOverlayIcon = vi.fn()
    const window = {
      isDestroyed: () => false,
      isFocused: () => false,
      setOverlayIcon,
    }

    for (let index = 0; index < 10; index += 1) {
      controller.noteUnfocusedAttention(() => window)
    }

    expect(controller.getUnreadCount()).toBe(10)
    expect(setOverlayIcon).toHaveBeenLastCalledWith({ kind: "badge-icon" }, "10 条未读通知")
    expect(bitmaps.at(-1)).toEqual(controller.renderBadgeBitmap("9+"))
  })

  it("uses the native Dock badge on macOS", () => {
    const setBadgeCount = vi.fn(() => true)
    const setOverlayIcon = vi.fn()
    const controller = createAttentionBadgeController({
      platform: "darwin",
      setBadgeCount,
      createFromBitmap: vi.fn(() => ({ kind: "badge-icon" })),
    })

    controller.noteUnfocusedAttention(() => ({
      isDestroyed: () => false,
      isFocused: () => false,
      setOverlayIcon,
    }))

    expect(setBadgeCount).toHaveBeenCalledWith(1)
    expect(setOverlayIcon).not.toHaveBeenCalled()
  })
})
