import { describe, expect, it } from "vitest"

import { nextExplicitTheme } from "./appearance-actions"

describe("nextExplicitTheme", () => {
  it("switches from the currently resolved theme to an explicit opposite theme", () => {
    expect(nextExplicitTheme("dark")).toBe("light")
    expect(nextExplicitTheme("light")).toBe("dark")
  })
})
