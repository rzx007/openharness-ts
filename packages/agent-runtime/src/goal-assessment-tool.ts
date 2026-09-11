import type { ToolDefinition } from "@openharness/core";

export function createGoalAssessmentTool(): ToolDefinition {
  return {
    name: "GoalAssessment",
    description: "Submit the outcome of the current durable goal turn. Call once at the end of a goal-linked run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "progress", "evidence"],
      properties: {
        decision: { type: "string", enum: ["continue", "complete", "waiting_user", "blocked"] },
        progress: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        nextStep: { type: "string" },
        reason: { type: "string" },
        question: { type: "string" },
      },
    },
    execution: { domain: "control_plane", supportedEnvironments: ["local", "wsl"] },
    async execute(input, context) {
      if (!context.agent || typeof input.decision !== "string" || typeof input.progress !== "string" || !Array.isArray(input.evidence) || !input.evidence.every((item) => typeof item === "string")) {
        return { isError: true, content: [{ type: "text", text: "Goal assessment is unavailable or invalid." }] };
      }
      await context.agent.emit({
        type: "domain.event",
        data: {
          name: "goal.assessment",
          payload: {
            decision: input.decision,
            progress: input.progress,
            evidence: input.evidence,
            ...(typeof input.nextStep === "string" ? { nextStep: input.nextStep } : {}),
            ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
            ...(typeof input.question === "string" ? { question: input.question } : {}),
          },
        },
      });
      return { content: [{ type: "text", text: "Goal assessment recorded." }] };
    },
  };
}
