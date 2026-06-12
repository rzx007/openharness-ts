import { readFileSync } from "node:fs";

/**
 * CLI 版本号唯一来源：运行时读 apps/cli/package.json。
 * src/ 与 dist/ 都是 package.json 的下一级目录，"../package.json" 两态通用。
 */
function readPackageVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string = readPackageVersion();
