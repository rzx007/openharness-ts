import { isAbsolute, resolve } from "node:path";

export function resolveToolPath(rawPath: string, cwd: string): string {
  const normalized = normalizeToolPath(rawPath);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

export function normalizeToolPath(
  rawPath: string,
  platformName: NodeJS.Platform = process.platform
): string {
  if (platformName !== "win32") return rawPath;

  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(rawPath);
  if (!match) return rawPath;

  const drive = match[1]!.toUpperCase();
  const rest = match[2]?.replace(/\//g, "\\") ?? "";
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}
