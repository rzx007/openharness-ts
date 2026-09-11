import type { ToolDefinition } from "@openharness/core";

const textSchema = { type: "string", minLength: 1, maxLength: 4000 };
export const GOAL_ASSESSMENT_TOOL_NAME = "GoalAssessment";
function validText(value: unknown, max = 4000): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.trim().length <= max
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

export function createGoalAssessmentTool(): ToolDefinition {
  return {
    name: GOAL_ASSESSMENT_TOOL_NAME,
    description: "Submit the outcome of the current durable goal turn. Call once at the end of a goal-linked run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "progress", "evidence"],
      properties: {
        decision: { type: "string", enum: ["continue", "complete", "waiting_user", "blocked"] },
        progress: textSchema,
        evidence: { type: "array", maxItems: 32, items: textSchema },
        evidenceRefs: {
          type: "array", maxItems: 32,
          items: {
            type: "object", additionalProperties: false, required: ["messagePartId", "criterion"],
            properties: { messagePartId: { type: "string", minLength: 1, maxLength: 256 }, criterion: textSchema },
          },
        },
        nextStep: textSchema,
        reason: textSchema,
        question: textSchema,
      },
    },
    execution: { domain: "control_plane", supportedEnvironments: ["local", "wsl"] },
    async execute(input, context) {
      const goal = context.agent?.goal;
      if (!goal || !context.agent || typeof input.decision !== "string" || !["continue", "complete", "waiting_user", "blocked"].includes(input.decision) || !validText(input.progress) || !Array.isArray(input.evidence) || input.evidence.length > 32 || !input.evidence.every((item) => validText(item)) || ![input.nextStep, input.reason, input.question].every((item) => item === undefined || validText(item))) {
        return { isError: true, content: [{ type: "text", text: "Goal assessment is unavailable or invalid." }] };
      }
      const refs = input.evidenceRefs ?? [];
      if (!Array.isArray(refs) || refs.length > 32 || !refs.every((ref) => ref && typeof ref === "object" && validText(ref.messagePartId, 256) && validText(ref.criterion))) {
        return { isError: true, content: [{ type: "text", text: "Invalid goal evidence references." }] };
      }
      await context.agent.emit({
        type: "domain.event",
        data: {
          name: "goal.assessment",
          payload: {
            goalId: goal.goalId,
            revision: goal.revision,
            runId: context.agent.scope.runId,
            decision: input.decision,
            progress: input.progress,
            evidence: input.evidence,
            evidenceRefs: refs,
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
