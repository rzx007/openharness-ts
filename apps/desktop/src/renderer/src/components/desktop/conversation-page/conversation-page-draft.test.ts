import { describe, expect, it } from "vitest"

import { resolveDraftAfterSubmission } from "./draft-submission"

describe("resolveDraftAfterSubmission", () => {
  it("clears the submitted draft only while the same session still owns it", () => {
    expect(resolveDraftAfterSubmission("request", "request", "session-a", "session-a")).toBe("")
    expect(resolveDraftAfterSubmission("new draft", "request", "session-a", "session-b")).toBe(
      "new draft"
    )
    expect(resolveDraftAfterSubmission("request", "request", "session-a", "session-b")).toBe(
      "request"
    )
  })
})
