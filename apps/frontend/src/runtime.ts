export const MIN_WINDOWS_BUN_VERSION = "1.3.12";

type RuntimeInfo = {
  platform: string;
  bunVersion: string | null;
};

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return 0;
}

export function assertSupportedTuiRuntime(runtime: RuntimeInfo = {
  platform: process.platform,
  bunVersion: typeof Bun === "undefined" ? null : Bun.version,
}): void {
  if (runtime.platform !== "win32" || runtime.bunVersion === null) return;

  if (compareVersions(runtime.bunVersion, MIN_WINDOWS_BUN_VERSION) < 0) {
    throw new Error(
      `Windows TUI requires Bun ${MIN_WINDOWS_BUN_VERSION} or newer; found ${runtime.bunVersion}. Run: bun upgrade`,
    );
  }
}
