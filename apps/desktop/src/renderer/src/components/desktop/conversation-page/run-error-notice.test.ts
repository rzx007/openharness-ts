// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { RunErrorNotice } from "./message/run-error-notice"

describe("RunErrorNotice", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("keeps the raw error collapsed behind a calm inline status", () => {
    act(() => root.render(createElement(RunErrorNotice, { error: "413 status code (no body)" })))

    const status = container.querySelector("[data-run-error-notice]")
    const details = status?.querySelector("details")
    const summary = details?.querySelector("summary")

    expect(status?.textContent).toContain("这次请求没有完成")
    expect(details?.open).toBe(false)
    expect(summary?.textContent).toContain("详情")
    expect(details?.querySelector("pre")?.textContent).toBe("413 status code (no body)")
    expect(status?.className).not.toContain("border")
    expect(status?.className).not.toContain("bg-destructive")
    expect(summary?.getAttribute("aria-live")).toBe("polite")
    expect(summary?.querySelector("svg")?.className.baseVal).toContain("text-amber")
    expect(summary?.querySelector("div, p")).toBeNull()
  })

  it("shows model mismatch guidance without exposing the raw error by default", () => {
    const error = "This model is not supported when using Codex"
    act(() => root.render(createElement(RunErrorNotice, { error })))

    const status = container.querySelector("[data-run-error-notice]")
    expect(status?.textContent).toContain("当前模型与供应商不匹配")
    expect(status?.querySelector("details")?.open).toBe(false)
    expect(status?.querySelector("pre")?.textContent).toBe(error)
  })

  it("does not render an empty details control when no error was returned", () => {
    act(() => root.render(createElement(RunErrorNotice, {})))

    expect(container.textContent).toContain("这次请求没有完成")
    expect(container.textContent).toContain("暂时没有更多错误信息")
    expect(container.querySelector("details")).toBeNull()
    expect(container.querySelector("summary")).toBeNull()
    expect(container.querySelector("[data-run-error-status-row]")?.getAttribute("aria-live")).toBe(
      "polite"
    )
  })
})
