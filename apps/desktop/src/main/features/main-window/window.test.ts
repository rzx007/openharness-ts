import { describe, expect, it } from "vitest"

import { mainWindowChromeOptions } from "./window-chrome"

describe("mainWindowChromeOptions", () => {
  it("uses inset traffic lights on macOS", () => {
    expect(mainWindowChromeOptions("darwin")).toEqual({
      frame: true,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 11 },
    })
  })

  it.each(["win32", "linux"] as const)("uses a frameless window on %s", (platform) => {
    expect(mainWindowChromeOptions(platform)).toEqual({ frame: false })
  })
})
