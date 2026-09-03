// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopUpdateState } from "@shared/update-types"
import { UpdateDialog } from "./update-dialog"

describe("UpdateDialog", () => {
  let container: HTMLDivElement
  let root: Root
  let emitState: (state: DesktopUpdateState) => void
  const unsubscribe = vi.fn()
  const updates = {
    getState: vi.fn<() => Promise<DesktopUpdateState>>(),
    download: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    onStateChanged: vi.fn((listener: (state: DesktopUpdateState) => void) => {
      emitState = listener
      return unsubscribe
    }),
  }

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    updates.getState.mockResolvedValue({ status: "idle" })
    Reflect.set(window, "desktop", { updates })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    Reflect.deleteProperty(window, "desktop")
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  })

  it("offers a new version and lets the user defer or start its download", async () => {
    updates.getState.mockResolvedValue({ status: "available", version: "1.8.0" })
    await mount()

    expect(document.body.textContent).toContain("1.8.0")
    expect(findButton("稍后")).not.toBeNull()
    await click("下载更新")
    expect(updates.download).toHaveBeenCalledOnce()

    await act(async () => emitState({ status: "available", version: "1.9.0" }))
    await click("稍后")
    expect(document.body.textContent).not.toContain("1.9.0")
  })

  it("shows download progress without another download action", async () => {
    updates.getState.mockResolvedValue({
      status: "downloading",
      version: "2.0.0",
      percent: 37.6,
      transferred: 3_760,
      total: 10_000,
      bytesPerSecond: 500,
    })
    await mount()

    expect(document.body.textContent).toContain("38%")
    expect(document.body.textContent).toContain("3.7 KB / 9.8 KB")
    expect(findButton("下载更新")).toBeNull()
  })

  it("offers restart after download and shows user-triggered errors", async () => {
    updates.getState.mockResolvedValue({ status: "downloaded", version: "2.1.0" })
    await mount()

    await click("立即重启安装")
    expect(updates.install).toHaveBeenCalledOnce()

    await act(async () =>
      emitState({ status: "error", version: "2.1.0", message: "下载文件校验失败" })
    )
    expect(document.body.textContent).toContain("下载文件校验失败")
    expect(findButton("关闭")).not.toBeNull()
  })

  it("unsubscribes from update state changes when unmounted", async () => {
    await mount()
    act(() => root.unmount())
    expect(unsubscribe).toHaveBeenCalledOnce()
    root = createRoot(container)
  })

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(createElement(UpdateDialog))
    })
  }

  async function click(label: string): Promise<void> {
    await act(async () => {
      findButton(label)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  }
})

function findButton(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label
    ) ?? null
  )
}
