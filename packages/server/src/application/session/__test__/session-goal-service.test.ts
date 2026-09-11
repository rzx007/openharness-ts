import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { SessionStore } from "@openharness/services"
import { SessionGoalService } from "../session-goal-service.js"

describe("SessionGoalService", () => {
  it("queues the next goal revision after a continue assessment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-goal-service-"))
    const store = new SessionStore({ path: join(directory, "store.db") })
    try {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" })
      const goal = store.createGoal({ sessionId: "s1", objective: "完成目标", maxAutoTurns: 20 })
      const input = store.admitPrompt({ id: "i1", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: goal.objective }] })
      const run = store.createRun({ id: "r1", sessionId: "s1", inputId: input.id, metadata: { goalId: goal.id, goalRevision: 0 } })
      store.updateRun(run.id, { metadata: { goalAssessment: { decision: "continue", progress: "完成一部分", evidence: ["检查通过"] } } })
      const admitPrompt = vi.fn(async () => ({ input, run, queue_state: "queued" as const }))
      const service = new SessionGoalService({ store, sessions: { admitPrompt }, runEngine: { interruptSession: vi.fn(), activeRunId: vi.fn() } })

      await service.settleRun("s1", "r1")

      expect(store.getGoal(goal.id)).toMatchObject({ revision: 1, autoTurnsUsed: 1, status: "active" })
      expect(admitPrompt).toHaveBeenCalledWith("s1", expect.objectContaining({ runMetadata: expect.objectContaining({ goalRevision: 1, goalRunKind: "continuation" }) }))
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
