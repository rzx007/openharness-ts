import { readFileSync } from "node:fs"

import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")

describe("startup loading document", () => {
  it("shows an accessible wordmark before React mounts", () => {
    const document = new JSDOM(html).window.document
    const loading = document.querySelector("#startup-loading")

    expect(loading?.getAttribute("role")).toBe("status")
    expect(loading?.getAttribute("aria-label")).toBe("正在启动 OpenHarness")
    expect(loading?.textContent).toContain("OpenHarness")
    expect(loading?.querySelectorAll('[data-startup-dot="true"]')).toHaveLength(3)
    expect(document.querySelector("#root")?.contains(loading ?? null)).toBe(true)
  })

  it("supports dark color preference and reduced motion without JavaScript", () => {
    const styles = new JSDOM(html).window.document.querySelector("style")?.textContent ?? ""

    expect(styles).toContain("prefers-color-scheme: dark")
    expect(styles).toContain("prefers-reduced-motion: reduce")
    expect(styles).toContain("animation: none")
  })
})
