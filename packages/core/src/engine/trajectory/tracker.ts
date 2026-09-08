import type { ToolExecutionResult } from "../../types/tools.js";
import type { ToolUseBlock } from "../../types/messages.js";

export interface TrajectoryCall {
  toolUse: ToolUseBlock;
  result: ToolExecutionResult;
}

export interface TrajectoryEvent {
  calls: TrajectoryCall[];
}

export interface TrajectoryLoopControl {
  guidance: string | undefined;
  forceFinal: boolean;
  hiddenTools: string[];
}

export interface TrajectoryTracker {
  observe(event: TrajectoryEvent, control: TrajectoryLoopControl): void;
}

const EXEMPT_TOOLS = new Set([
  "BackgroundShellCreate",
  "JobList",
  "JobRead",
  "JobWait",
  "JobSend",
  "JobCancel",
]);

export class DefaultTrajectoryTracker implements TrajectoryTracker {
  private consecutiveNoEvidence = 0;
  private readonly seenSuccessfulResults = new Set<string>();

  observe(event: TrajectoryEvent, control: TrajectoryLoopControl): void {
    for (const call of event.calls) {
      if (EXEMPT_TOOLS.has(call.toolUse.name)) continue;
      const evidence = successfulEvidence(call.result);
      if (evidence && !this.seenSuccessfulResults.has(evidence)) {
        this.seenSuccessfulResults.add(evidence);
        this.consecutiveNoEvidence = 0;
        control.guidance = undefined;
        continue;
      }

      this.consecutiveNoEvidence += 1;
      if (this.consecutiveNoEvidence >= 2) {
        control.guidance =
          "The last two consecutive tool calls produced no new evidence. Before calling another tool, decide whether the user's core request can be answered from existing results. Do not use tools only to reformat, recount, or reconfirm known information.";
      }
      if (this.consecutiveNoEvidence >= 3) {
        if (!control.hiddenTools.includes(call.toolUse.name)) {
          control.hiddenTools.push(call.toolUse.name);
        }
        control.forceFinal = true;
      }
    }
  }
}

export function createTrajectoryLoopControl(): TrajectoryLoopControl {
  return { guidance: undefined, forceFinal: false, hiddenTools: [] };
}

/** The Query Engine's single removable integration point for trajectory policy. */
export function applyTrajectoryTracker(
  tracker: TrajectoryTracker | undefined,
  event: TrajectoryEvent,
  control: TrajectoryLoopControl,
): void {
  tracker?.observe(event, control);
}

function successfulEvidence(result: ToolExecutionResult): string | undefined {
  if (result.isError) return undefined;
  const text = result.content
    .map((block) => block.type === "text" ? block.text.trim() : "")
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}
