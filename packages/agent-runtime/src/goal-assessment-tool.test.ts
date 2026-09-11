import { describe, expect, it, vi } from "vitest"
import { createGoalAssessmentTool } from "./goal-assessment-tool.js"

describe("GoalAssessment tool", () => {
  it("emits a structured domain assessment", async () => {
    const emit = vi.fn(async () => undefined)
    const result = await createGoalAssessmentTool().execute(
      { decision: "continue", progress: "完成协议", evidence: ["protocol tests passed"], nextStep: "实现 UI" },
      { cwd: process.cwd(), sessionId: "s1", agent: { emit } as never },
    )
    expect(result.isError).not.toBe(true)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "domain.event", data: expect.objectContaining({ name: "goal.assessment" }) }))
  })
})
