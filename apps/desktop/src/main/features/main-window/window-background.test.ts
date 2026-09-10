import { describe, expect, it } from "vitest"

import { mainWindowBackgroundColor } from "./window-background"

describe("mainWindowBackgroundColor", () => {
  it("matches the dark splash background", () => {
    expect(mainWindowBackgroundColor(true)).toBe("#20242a")
  })

  it("matches the light splash background", () => {
    expect(mainWindowBackgroundColor(false)).toBe("#f4f7f9")
  })
})
