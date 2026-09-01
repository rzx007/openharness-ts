import { describe, expect, it } from "vitest"

import { isHtmlPath, shouldOfferHtmlBrowserOpen } from "./file-viewer-model"

describe("isHtmlPath", () => {
  it("recognizes HTML and HTM extensions without case sensitivity", () => {
    expect(isHtmlPath("site/index.html")).toBe(true)
    expect(isHtmlPath("site/legacy.HTM")).toBe(true)
  })

  it("rejects non-HTML files", () => {
    expect(isHtmlPath("site/index.ts")).toBe(false)
  })
})

describe("shouldOfferHtmlBrowserOpen", () => {
  it("offers browser rendering only when HTML exceeds 5000 lines", () => {
    expect(shouldOfferHtmlBrowserOpen("report.html", lines(5_000))).toBe(false)
    expect(shouldOfferHtmlBrowserOpen("report.HTML", lines(5_001))).toBe(true)
  })

  it("does not offer browser rendering for a non-HTML file", () => {
    expect(shouldOfferHtmlBrowserOpen("report.ts", lines(5_001))).toBe(false)
  })
})

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}
