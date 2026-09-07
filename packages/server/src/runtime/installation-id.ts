import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

const INSTALLATION_ID_NAMESPACE = "openharness-installation-v1\0";

export function deriveInstallationId(
  dataDirectory: string,
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  const normalized = hostPlatform === "win32"
    ? win32.resolve(dataDirectory).replaceAll("\\", "/").toLowerCase()
    : posix.resolve(dataDirectory);
  return createHash("sha256")
    .update(`${INSTALLATION_ID_NAMESPACE}${normalized}`)
    .digest("hex")
    .slice(0, 32);
}
