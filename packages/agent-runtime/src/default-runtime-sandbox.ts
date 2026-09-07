import type { RuntimeBundle } from "@openharness/core";
import { startSandboxRuntime } from "@openharness/sandbox";
import type { SandboxRuntimeReporter } from "@openharness/sandbox";

const bundlesWithExitCleanup = new Set<RuntimeBundle>();
let exitCleanupInstalled = false;

export async function attachSandboxRuntime(
  bundle: RuntimeBundle,
  cwd: string,
  reporter?: SandboxRuntimeReporter,
  sessionId?: string,
): Promise<void> {
  const sandboxRuntime = await startSandboxRuntime({
    settings: bundle.settings,
    cwd,
    sessionId,
    reporter,
  });
  bundle.sandboxStatus = sandboxRuntime.status;

  if (
    sandboxRuntime.status.backend !== "docker" ||
    !sandboxRuntime.status.active
  ) {
    return;
  }

  bundle.addCleanup(
    () => sandboxRuntime.stop(),
    () => sandboxRuntime.stopSync(),
  );
  registerExitCleanup(bundle);
}

function registerExitCleanup(bundle: RuntimeBundle): void {
  bundlesWithExitCleanup.add(bundle);
  bundle.addCleanup(() => {
    bundlesWithExitCleanup.delete(bundle);
  });
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.on("exit", () => {
    for (const runtime of bundlesWithExitCleanup) {
      runtime.closeSync();
    }
    bundlesWithExitCleanup.clear();
  });
}
