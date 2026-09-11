import { describe, expect, it } from "vitest"
import { parseCreateSessionGoalInput, parseGoalActionInput, parseGoalAssessment } from "./session-goals.js"

describe("session goal protocol", () => {
  it("normalizes valid goal input", () => {
    expect(parseCreateSessionGoalInput({ requestId: "r1", objective: "  完成目标  " })).toEqual({ requestId: "r1", objective: "完成目标" })
  })

  it("rejects empty goals and invalid resume budgets", () => {
    expect(() => parseCreateSessionGoalInput({ requestId: "r1", objective: " " })).toThrow()
    expect(() => parseGoalActionInput({ requestId: "r1", expectedRevision: 0, action: "resume", additionalAutoTurns: 0 })).toThrow()
  })

  it("validates structured goal content instead of casting unknown input", () => {
    for (const value of [null, {}, [{ type: "unknown" }], [{ type: "text", text: 7 }]]) {
      expect(() => parseCreateSessionGoalInput({ requestId: "r1", objective: "完成目标", items: value })).toThrow()
    }
    expect(() => parseCreateSessionGoalInput({ requestId: "r1", objective: "完成目标", attachments: [{ assetId: "" }] })).toThrow()
    expect(parseCreateSessionGoalInput({ requestId: "r1", objective: "完成目标", items: [{ type: "context", kind: "conversation", id: "s1", displayName: "说明" }] }).items?.[0].type).toBe("context")
  })

  it("binds evidence to the host run and rejects malformed assessments", () => {
    const binding = { goalId: "g1", revision: 2, runId: "r1" }
    const assessment = parseGoalAssessment({ goalId: "forged", runId: "forged", decision: "complete", progress: "verified", evidence: ["test passed"], evidenceRefs: [{ messagePartId: "part1", criterion: "test passes", runId: "forged" }] }, binding)
    expect(assessment).toMatchObject(binding)
    expect(assessment.evidenceRefs[0]).toMatchObject(binding)
    const waiting = parseGoalAssessment({ decision: "waiting_user", progress: "等待确认", evidence: [], question: "选哪个数据源？" }, binding)
    expect(parseGoalAssessment(waiting, binding)).toEqual(waiting)
    for (const decision of ["done", null, 1]) expect(() => parseGoalAssessment({ decision, progress: "work", evidence: [] }, binding)).toThrow()
  })
})
