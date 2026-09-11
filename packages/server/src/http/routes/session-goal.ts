import { Hono } from "hono";
import { parseCreateSessionGoalInput, parseGoalActionInput, parseUpdateSessionGoalInput } from "@openharness/protocol";
import type { SessionGoalService } from "../../application/session/session-goal-service.js";
import { applicationErrorResponse, jsonResponse, readJson } from "../support.js";

export function createSessionGoalRoutes(goals: SessionGoalService): Hono {
  return new Hono()
    .get("/:sessionId/goal", (c) => jsonResponse({ goal: goals.get(c.req.param("sessionId")) }))
    .post("/:sessionId/goals", async (c) => {
      try {
        return jsonResponse({ goal: await goals.create(c.req.param("sessionId"), parseCreateSessionGoalInput(await readJson(c))) }, 201);
      } catch (error) { return applicationErrorResponse(error, 400); }
    })
    .patch("/:sessionId/goals/:goalId", async (c) => {
      try {
        return jsonResponse({ goal: await goals.update(c.req.param("sessionId"), c.req.param("goalId"), parseUpdateSessionGoalInput(await readJson(c))) });
      } catch (error) { return applicationErrorResponse(error, 400); }
    })
    .post("/:sessionId/goals/:goalId/actions", async (c) => {
      try {
        return jsonResponse({ goal: goals.action(c.req.param("sessionId"), c.req.param("goalId"), parseGoalActionInput(await readJson(c))) });
      } catch (error) { return applicationErrorResponse(error, 400); }
    });
}
