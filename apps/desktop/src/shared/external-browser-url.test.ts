import { describe, expect, it } from "vitest"

import { toExternalBrowserUrl } from "./external-browser-url"

describe("toExternalBrowserUrl", () => {
  it("keeps http, https, and local file addresses", () => {
    expect(toExternalBrowserUrl("https://example.com/docs")).toBe("https://example.com/docs")
    expect(toExternalBrowserUrl("http://localhost:5173/demo")).toBe("http://localhost:5173/demo")
    expect(toExternalBrowserUrl("file:///D:/demo/index.html")).toBe("file:///D:/demo/index.html")
  })

  it("rejects empty values and unsafe protocols", () => {
    expect(toExternalBrowserUrl("")).toBeNull()
    expect(toExternalBrowserUrl("   ")).toBeNull()
    expect(toExternalBrowserUrl("javascript:alert(1)")).toBeNull()
    expect(toExternalBrowserUrl("data:text/html,hi")).toBeNull()
    expect(toExternalBrowserUrl("example.com")).toBeNull()
  })
})
