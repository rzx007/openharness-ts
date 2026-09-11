import { describe, expect, it } from "vitest"
import { parseCreateSessionGoalInput, parseGoalActionInput } from "./session-goals.js"

describe("session goal protocol", () => {
  it("normalizes valid goal input", () => {
    expect(parseCreateSessionGoalInput({ requestId: "r1", objective: "  完成目标  " })).toEqual({ requestId: "r1", objective: "完成目标" })
  })

  it("rejects empty goals and invalid resume budgets", () => {
    expect(() => parseCreateSessionGoalInput({ requestId: "r1", objective: " " })).toThrow()
    expect(() => parseGoalActionInput({ requestId: "r1", expectedRevision: 0, action: "resume", additionalAutoTurns: 0 })).toThrow()
  })
})
