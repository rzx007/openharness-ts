import { expect, it } from "vitest";
import { FrameworkAgentRun } from "./framework-agent-run.js";
import { AgentEventBus } from "./event-source.js";
import { ToolRegistry } from "@openharness/core";

it("preserves original structured items in root and steer acceptance events", async () => {
  const observed: unknown[] = [];
  const items = [{ type: "skill", name: "review", path: "/review/SKILL.md" }];
  const run = new FrameworkAgentRun({
    agentId: "a",
    ids: { inputId: "root", runId: "run", traceId: "trace" },
    content: "root instruction",
    inputItems: items,
    delivery: "queue",
    eventBus: new AgentEventBus((event) => {
      if (event.type === "input.accepted") observed.push(event.data);
    }),
    session: {
      id: "s",
      getHistory: () => [],
      submitMessage: async function* (_content: string, options: any) {
        await options.execution.takeSteeredInputs();
        yield { type: "complete", stopReason: "end_turn" };
      },
    } as any,
    runtime: {
      queryEngine: {
        getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
      },
    } as any,
    effects: {} as any,
    children: { cwd: "/repo", createController: () => ({}) } as any,
    onSettled: () => {},
  } as any);
  const receipt = run.steer({
    id: "steer",
    content: "steer instruction",
    inputItems: items,
  } as any);
  await run.result;
  await receipt;
  expect(observed).toEqual([
    { content: "root instruction", inputItems: items, delivery: "queue" },
    { content: "steer instruction", inputItems: items, delivery: "steer" },
  ]);
});

it("scopes the assessment tool and binding to each run without mutating the runtime registry", async () => {
  const toolRegistry = new ToolRegistry();
  const observed: unknown[] = [];
  const runtime = {
    toolRegistry,
    queryEngine: { getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }) },
  };
  for (const goal of [{ goalId: "g1", revision: 1 }, undefined, { goalId: "g2", revision: 3 }]) {
    const run = new FrameworkAgentRun({
      agentId: "a",
      goal,
      ids: {
        inputId: `i-${observed.length}`,
        runId: `r-${observed.length}`,
        traceId: "t",
      },
      content: "work",
      delivery: "queue",
      eventBus: new AgentEventBus(() => {}),
      session: {
        id: "s",
        getHistory: () => [],
        submitMessage: async function* (_: string, options: any) {
          observed.push({
            tools: options.execution.contribution?.tools?.map((item: any) => item.definition.name) ?? [],
            registryVisible: toolRegistry.has("GoalAssessment"),
          });
          yield { type: "complete", stopReason: "end_turn" };
        },
      } as any,
      runtime: runtime as any,
      effects: {} as any,
      children: { cwd: "/repo", createController: () => ({}) } as any,
      onSettled: () => {},
    });
    await run.result;
    expect(toolRegistry.has("GoalAssessment")).toBe(false);
  }
  expect(observed).toEqual([
    { tools: ["GoalAssessment"], registryVisible: false },
    { tools: [], registryVisible: false },
    { tools: ["GoalAssessment"], registryVisible: false },
  ]);
});
