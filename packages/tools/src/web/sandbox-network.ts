import type { ToolContext } from "@openharness/core";
import { resolveSandboxPolicy } from "@openharness/sandbox";
import { WebProviderError } from "./types.js";

/**
 * Web tools run on the host process network. When the active sandbox policy
 * isolates workloads with network.mode=none, refuse host egress so WebFetch /
 * WebSearch cannot bypass Docker/SRT isolation.
 */
export function assertSandboxAllowsHostWeb(context: ToolContext): void {
  const policy = resolveSandboxPolicy({
    cwd: context.cwd,
    sessionId: context.sessionId,
    settings: context.settings,
  });
  if (!policy.enabled) return;
  if (policy.network.mode !== "none") return;

  throw new WebProviderError(
    "network_denied",
    "Sandbox network.mode=none blocks host WebFetch/WebSearch. " +
      "Use network.mode=bridge, host, or proxy when outbound web access is required.",
  );
}
