import { readFileSync } from "node:fs"

import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")

describe("startup loading document", () => {
  it("shows an accessible wordmark overlay outside #root", () => {
    const document = new JSDOM(html).window.document
    const loading = document.querySelector("#startup-loading")
    const root = document.querySelector("#root")

    expect(loading?.getAttribute("role")).toBe("status")
    expect(loading?.getAttribute("aria-label")).toBe("正在启动 OpenHarness")
    expect(loading?.textContent).toContain("OpenHarness")
    expect(loading?.querySelectorAll('[data-startup-dot="true"]')).toHaveLength(3)
    expect(root?.contains(loading ?? null)).toBe(false)
    expect(loading?.previousElementSibling).toBe(root)
  })

  it("covers the window as a full-screen overlay after React mounts", () => {
    const styles = new JSDOM(html).window.document.querySelector("style")?.textContent ?? ""

    expect(styles).toContain("position: fixed")
    expect(styles).toContain("inset: 0")
    expect(styles).toContain("z-index: 9999")
  })

  it("paints stored and system themes without waiting for React", () => {
    const document = new JSDOM(html).window.document
    const styles = document.querySelector("style")?.textContent ?? ""
    const scripts = [...document.querySelectorAll("script")].map((script) =>
      script.getAttribute("src")
    )

    expect(scripts).toContain("./src/startup-theme.ts")
    expect(styles).toContain("prefers-color-scheme: dark")
    expect(styles).toContain("html.dark")
    expect(styles).toContain("html.light")
    expect(styles).toContain("#20242a")
    expect(styles).toContain("#f4f7f9")
    expect(styles).toContain("prefers-reduced-motion: reduce")
    expect(styles).toContain("animation: none")
    expect(styles).not.toContain("html.dark body")
    expect(styles).not.toContain("html.light body")
    expect(styles).not.toMatch(/body\s*,\s*#startup-loading/)
  })
})
