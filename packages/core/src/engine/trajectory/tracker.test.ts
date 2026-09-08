import { describe, expect, it } from "vitest";
import {
  DefaultTrajectoryTracker,
  applyTrajectoryTracker,
  createTrajectoryLoopControl,
} from "./tracker.js";

const failed = (toolName = "Shell") => ({
  toolUse: { type: "tool_use" as const, id: crypto.randomUUID(), name: toolName, input: {} },
  result: { toolUseId: crypto.randomUUID(), toolName, content: [{ type: "text" as const, text: "failed" }], isError: true },
});

describe("DefaultTrajectoryTracker", () => {
  it("strengthens guidance after two no-evidence outcomes", () => {
    const tracker = new DefaultTrajectoryTracker();
    const control = createTrajectoryLoopControl();
    applyTrajectoryTracker(tracker, { calls: [failed(), failed()] }, control);
    expect(control.guidance).toContain("two consecutive tool calls");
    expect(control.forceFinal).toBe(false);
  });

  it("hides the stalled tool and forces a final response after three", () => {
    const tracker = new DefaultTrajectoryTracker();
    const control = createTrajectoryLoopControl();
    applyTrajectoryTracker(tracker, { calls: [failed(), failed(), failed()] }, control);
    expect(control.forceFinal).toBe(true);
    expect(control.hiddenTools).toContain("Shell");
  });

  it("fully exempts background and Job tools", () => {
    const tracker = new DefaultTrajectoryTracker();
    const control = createTrajectoryLoopControl();
    applyTrajectoryTracker(tracker, {
      calls: [failed("BackgroundShellCreate"), failed("JobWait"), failed("JobRead"), failed("JobCancel")],
    }, control);
    expect(control).toEqual({ guidance: undefined, forceFinal: false, hiddenTools: [] });
  });

  it("does nothing when the single integration call has no tracker", () => {
    const control = createTrajectoryLoopControl();
    applyTrajectoryTracker(undefined, { calls: [failed(), failed(), failed()] }, control);
    expect(control).toEqual({ guidance: undefined, forceFinal: false, hiddenTools: [] });
  });
});
