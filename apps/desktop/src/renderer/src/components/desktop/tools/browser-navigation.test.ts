import { describe, expect, it } from "vitest"

import {
  browserTitleFromUrl,
  displayBrowserUrl,
  normalizeBrowserUrl,
  toLocalFileUrl,
} from "./browser-navigation"

describe("normalizeBrowserUrl", () => {
  it("converts a Windows absolute path into a file URL", () => {
    expect(normalizeBrowserUrl("D:\\demo site\\index.html")).toBe(
      "file:///D:/demo%20site/index.html"
    )
  })

  it("keeps an existing file URL", () => {
    expect(normalizeBrowserUrl("file:///D:/demo/index.html")).toBe("file:///D:/demo/index.html")
  })

  it("keeps normal web address behavior", () => {
    expect(normalizeBrowserUrl("localhost:5173/demo")).toBe("http://localhost:5173/demo")
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com")
  })
})

describe("toLocalFileUrl", () => {
  it("joins a project root and relative HTML path", () => {
    expect(toLocalFileUrl("D:\\code\\OpenHarness", "examples/page demo/index.html")).toBe(
      "file:///D:/code/OpenHarness/examples/page%20demo/index.html"
    )
  })
})

describe("local file address presentation", () => {
  it("keeps the file scheme in the address bar after navigation", () => {
    expect(displayBrowserUrl("file:///D:/demo%20site/index.html")).toBe(
      "file:///D:/demo%20site/index.html"
    )
  })

  it("uses the local filename when the page has no title", () => {
    expect(browserTitleFromUrl("file:///D:/demo%20site/index.html")).toBe("index.html")
  })
})
