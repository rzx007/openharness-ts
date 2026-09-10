// @vitest-environment jsdom

import { describe, expect, it } from "vitest"

import { dismissStartupLoading } from "./dismiss-startup-loading"

describe("dismissStartupLoading", () => {
  it("removes the HTML splash overlay without touching #root", () => {
    document.body.innerHTML = `
      <div id="root"><span>app</span></div>
      <div id="startup-loading">splash</div>
    `

    dismissStartupLoading()

    expect(document.getElementById("startup-loading")).toBeNull()
    expect(document.getElementById("root")?.textContent).toBe("app")
  })

  it("is a no-op when the splash is already gone", () => {
    document.body.innerHTML = `<div id="root"></div>`

    expect(() => dismissStartupLoading()).not.toThrow()
  })
})
