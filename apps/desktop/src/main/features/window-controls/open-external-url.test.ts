import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { openUrlInDefaultBrowser } from "./open-external-url"

describe("openUrlInDefaultBrowser", () => {
  it("opens http and https addresses with the system browser", async () => {
    const openExternal = vi.fn(async () => undefined)
    const openPath = vi.fn(async () => "")

    await openUrlInDefaultBrowser("https://example.com/docs", { openExternal, openPath })

    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs")
    expect(openPath).not.toHaveBeenCalled()
  })

  it("opens local file addresses with the default application for that file", async () => {
    const openExternal = vi.fn(async () => undefined)
    const openPath = vi.fn(async () => "")
    const fileUrl =
      process.platform === "win32" ? "file:///D:/demo/index.html" : "file:///tmp/demo/index.html"

    await openUrlInDefaultBrowser(fileUrl, { openExternal, openPath })

    expect(openPath).toHaveBeenCalledWith(fileURLToPath(fileUrl))
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("rejects addresses that are not safe to hand to the OS", async () => {
    const openExternal = vi.fn(async () => undefined)
    const openPath = vi.fn(async () => "")

    await expect(
      openUrlInDefaultBrowser("javascript:alert(1)", { openExternal, openPath })
    ).rejects.toThrow("无法在系统浏览器中打开该地址。")
    expect(openExternal).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
  })
})
