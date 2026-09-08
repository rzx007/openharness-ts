export interface ShellTraceEvent {
  status: "completed" | "failed";
  failureFingerprint?: string;
}

export function evaluateShellTrace(events: readonly ShellTraceEvent[]) {
  const seenFailures = new Set<string>();
  let failures = 0;
  let repeatedFailureFingerprints = 0;
  for (const event of events) {
    if (event.status !== "failed") continue;
    failures += 1;
    if (!event.failureFingerprint) continue;
    if (seenFailures.has(event.failureFingerprint)) repeatedFailureFingerprints += 1;
    else seenFailures.add(event.failureFingerprint);
  }
  return { calls: events.length, failures, repeatedFailureFingerprints };
}
