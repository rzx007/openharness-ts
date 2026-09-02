// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_APPEARANCE_PREFERENCES } from "./appearance-preferences"

const mocks = vi.hoisted(() => ({ useAppearance: vi.fn() }))

vi.mock("./appearance-provider", () => ({
  useAppearance: mocks.useAppearance,
}))

import { AppearanceSettings } from "./appearance-settings"

describe("AppearanceSettings", () => {
  let container: HTMLDivElement
  let root: Root
  let setPreference: ReturnType<typeof vi.fn>
  let resetAppearance: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    setPreference = vi.fn(() => true)
    resetAppearance = vi.fn(() => true)
    mocks.useAppearance.mockReturnValue({
      preferences: DEFAULT_APPEARANCE_PREFERENCES,
      resolvedTheme: "light",
      resolvedReducedMotion: false,
      fontAvailability: {
        "segoe-ui": false,
        "cascadia-code": false,
        "cascadia-mono": false,
        consolas: false,
      },
      saveState: { status: "idle" },
      setPreference,
      resetAppearance,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.querySelectorAll('[data-slot="alert-dialog-portal"]').forEach((node) => node.remove())
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  async function renderSettings(): Promise<void> {
    await act(async () => {
      root.render(createElement(AppearanceSettings))
    })
  }

  it("commits theme and preset selections immediately", async () => {
    await renderSettings()

    const darkTheme = container.querySelector<HTMLButtonElement>('[aria-label="深色主题"]')
    const blueAccent = container.querySelector<HTMLButtonElement>('[aria-label="蓝色强调色"]')
    expect(darkTheme).not.toBeNull()
    expect(blueAccent).not.toBeNull()

    act(() => darkTheme?.click())
    act(() => blueAccent?.click())

    expect(setPreference).toHaveBeenCalledWith("theme", "dark")
    expect(setPreference).toHaveBeenCalledWith("accent", { kind: "preset", id: "blue" })
  })

  it("keeps incomplete custom color text and commits only a complete HEX value", async () => {
    await renderSettings()
    const input = container.querySelector<HTMLInputElement>('[aria-label="自定义强调色"]')
    expect(input).not.toBeNull()

    act(() => {
      setInputValue(input, "#12")
      input?.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(input?.value).toBe("#12")
    expect(setPreference).not.toHaveBeenCalledWith("accent", expect.anything())

    act(() => {
      setInputValue(input, "#006aff")
      input?.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(setPreference).toHaveBeenCalledWith("accent", {
      kind: "custom",
      value: "#006AFF",
    })
  })

  it("shows save feedback and asks before restoring defaults", async () => {
    mocks.useAppearance.mockReturnValue({
      preferences: DEFAULT_APPEARANCE_PREFERENCES,
      resolvedTheme: "light",
      resolvedReducedMotion: false,
      fontAvailability: {},
      saveState: { status: "saved" },
      setPreference,
      resetAppearance,
    })
    await renderSettings()

    const liveRegion = container.querySelector('[aria-live="polite"]')
    expect(liveRegion?.textContent).toContain("已自动保存")

    const reset = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "恢复默认"
    )
    await act(async () => reset?.click())
    expect(document.body.textContent).toContain("恢复默认外观？")
    expect(document.body.textContent).toContain("主题、颜色、字体、字号和动效")

    const confirm = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "确认恢复"
    )
    act(() => confirm?.click())
    expect(resetAppearance).toHaveBeenCalledTimes(1)
  })

  it("renders an inline alert when automatic saving fails", async () => {
    mocks.useAppearance.mockReturnValue({
      preferences: DEFAULT_APPEARANCE_PREFERENCES,
      resolvedTheme: "light",
      resolvedReducedMotion: false,
      fontAvailability: {},
      saveState: { status: "error", message: "无法保存外观设置" },
      setPreference,
      resetAppearance,
    })
    await renderSettings()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法保存外观设置")
  })

  it("clamps number inputs and commits the reduced-motion preference", async () => {
    await renderSettings()

    const sizeInput = container.querySelector<HTMLInputElement>('[aria-label="界面字号数值"]')
    expect(sizeInput).not.toBeNull()
    act(() => {
      setInputValue(sizeInput, "99")
      sizeInput?.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(setPreference).toHaveBeenCalledWith("uiFontSize", 18)

    const motionOn = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "开启"
    )
    act(() => motionOn?.click())
    expect(setPreference).toHaveBeenCalledWith("reducedMotion", "on")
  })
})

function setInputValue(input: HTMLInputElement | null, value: string): void {
  if (!input) return
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
}
