import { describe, expect, it } from "vitest"

import { shouldOfferHtmlBrowserOpen } from "./file-viewer-model"

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
