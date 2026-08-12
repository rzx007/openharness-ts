import type { AgentChildController } from "@openharness/core";
import type { AwaitTaskResult } from "@openharness/services";

export async function awaitFrameworkChildTask(
  children: AgentChildController,
  taskId: string,
  timeoutMs?: number,
): Promise<AwaitTaskResult> {
  const completion = children.awaitChildAgent(taskId).then((result): AwaitTaskResult => ({
    status: result.status === "interrupted" ? "stopped" : result.status,
    output: result.output || result.error || "",
  }));
  if (timeoutMs === undefined) return completion;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<AwaitTaskResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "running", output: "", timedOut: true }),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
