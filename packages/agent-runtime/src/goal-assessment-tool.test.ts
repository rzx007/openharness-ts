import { describe, expect, it, vi } from "vitest"
import { createGoalAssessmentTool } from "./goal-assessment-tool.js"

describe("GoalAssessment tool", () => {
  it("emits a structured domain assessment", async () => {
    const emit = vi.fn(async () => undefined)
    const result = await createGoalAssessmentTool().execute(
      { decision: "continue", progress: "完成协议", evidence: ["protocol tests passed"], nextStep: "实现 UI" },
      { cwd: process.cwd(), sessionId: "s1", agent: { emit, goal: { goalId: "g1", revision: 2 }, scope: { runId: "r1" } } as never },
    )
    expect(result.isError).not.toBe(true)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "domain.event", data: expect.objectContaining({ name: "goal.assessment", payload: expect.objectContaining({ goalId: "g1", revision: 2, runId: "r1" }) }) }))
  })

  it("rejects an unbound run even when model input claims a goal", async () => {
    const emit = vi.fn()
    const result = await createGoalAssessmentTool().execute({ goalId: "forged", decision: "complete", progress: "done", evidence: ["done"] }, { cwd: process.cwd(), agent: { emit } as never })
    expect(result.isError).toBe(true)
    expect(emit).not.toHaveBeenCalled()
  })
})
