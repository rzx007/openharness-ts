import { expect, it } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import type { AgentExecutionContext, StreamMessageParams } from "../index.js";

it("keeps the host goal in request system context and does not leak it to the next run", async () => {
  const systems: Array<string | undefined> = [];
  const toolNames: string[][] = [];
  const registry = new ToolRegistry();
  registry.register({ name: "GoalAssessment", description: "goal", inputSchema: { type: "object" }, execute: async () => ({ content: [] }) });
  const engine = new QueryEngine({
    streamMessage: async function* (input: StreamMessageParams) {
      systems.push(input.system);
      toolNames.push(input.tools?.map((tool) => tool.name) ?? []);
      yield { type: "complete" as const, stopReason: "end_turn" };
    },
  }, registry, { checkTool: async () => ({ action: "allow", reason: "test" }) }, {
    execute: async () => ({ blocked: false }),
  } as any, { systemPrompt: "base" });
  engine.setAllowedTools(["Read"]);
  const execution = {
    goal: { goalId: "g1", revision: 1, objective: "unique-goal-objective" },
    emit: async () => {}, takeSteeredInputs: async () => [], closeSteering: () => {},
  } as unknown as AgentExecutionContext;
  for await (const _ of engine.submitMessage("work", { execution })) { /* drain */ }
  for await (const _ of engine.submitMessage("ordinary")) { /* drain */ }
  expect(systems[0]).toContain("unique-goal-objective");
  expect(systems[1]).toBe("base");
  expect(toolNames).toEqual([["GoalAssessment"], []]);
});
