import { expect, it } from "vitest";
import { FrameworkAgentRun } from "./framework-agent-run.js";
import { AgentEventBus } from "./event-source.js";

it("preserves original structured items in root and steer acceptance events", async () => {
  const observed: unknown[] = [];
  const items = [{ type: "skill", name: "review", path: "/review/SKILL.md" }];
  const run = new FrameworkAgentRun({
    agentId: "a", ids: { inputId: "root", runId: "run", traceId: "trace" },
    content: "root instruction", inputItems: items, delivery: "queue",
    eventBus: new AgentEventBus((event) => { if (event.type === "input.accepted") observed.push(event.data); }),
    session: {
      id: "s", getHistory: () => [],
      submitMessage: async function* (_content: string, options: any) {
        await options.execution.takeSteeredInputs();
        yield { type: "complete", stopReason: "end_turn" };
      },
    } as any,
    runtime: { queryEngine: { getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }) } } as any,
    effects: {} as any, children: { cwd: "/repo", createController: () => ({}) } as any,
    onSettled: () => {},
  } as any);
  const receipt = run.steer({ id: "steer", content: "steer instruction", inputItems: items } as any);
  await run.result;
  await receipt;
  expect(observed).toEqual([
    { content: "root instruction", inputItems: items, delivery: "queue" },
    { content: "steer instruction", inputItems: items, delivery: "steer" },
  ]);
});
