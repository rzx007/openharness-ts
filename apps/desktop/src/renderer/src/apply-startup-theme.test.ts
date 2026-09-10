// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"

import { applyStartupTheme } from "./apply-startup-theme"
import { APPEARANCE_STORAGE_KEY } from "./components/appearance/appearance-preferences"

function stubMatchMedia(prefersDark: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: prefersDark && query.includes("prefers-color-scheme: dark"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    }),
  })
}

describe("applyStartupTheme", () => {
  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove("light", "dark")
    vi.unstubAllGlobals()
  })

  it("applies a stored dark theme before React mounts", () => {
    stubMatchMedia(false)
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, theme: "dark" }))

    applyStartupTheme()

    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.classList.contains("light")).toBe(false)
  })

  it("applies a stored light theme even when the OS is dark", () => {
    stubMatchMedia(true)
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, theme: "light" }))

    applyStartupTheme()

    expect(document.documentElement.classList.contains("light")).toBe(true)
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("follows the OS preference when the stored theme is system", () => {
    stubMatchMedia(true)
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, theme: "system" }))

    applyStartupTheme()

    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })
})
