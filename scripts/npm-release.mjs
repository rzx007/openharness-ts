import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const WORKSPACE_DIRS = ["apps", "packages"];
const PNPM_BIN = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const CLI_PACKAGE_NAME = "@rzx/ohs";
const SEMVER_CORE = /^\d+\.\d+\.\d+$/;

export const USAGE =
  "Usage: pnpm release:cli -- <x.y.z>   or   pnpm release:cli:dry -- <x.y.z>";

function commandInvocation(command, args) {
  if (process.platform !== "win32") return { command, args };
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")],
  };
}

function quoteCmdArg(arg) {
  if (/^[a-zA-Z0-9_/:=.,@%+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["^&|<>])/g, "^$1")}"`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function discoverWorkspacePackages() {
  const packages = [];
  for (const rootDir of WORKSPACE_DIRS) {
    const absRoot = join(ROOT, rootDir);
    for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(absRoot, entry.name);
      const packageJsonPath = join(dir, "package.json");
      if (!existsSync(packageJsonPath)) continue;
      const manifest = readJson(packageJsonPath);
      packages.push({ dir, packageJsonPath, manifest });
    }
  }
  return packages;
}

function getPackageByName(name) {
  const pkg = discoverWorkspacePackages().find((item) => item.manifest.name === name);
  if (!pkg) fail(`Workspace package not found: ${name}`);
  return pkg;
}

function writePackageVersion(pkg, version) {
  if (pkg.manifest.version === version) return false;
  pkg.manifest = { ...pkg.manifest, version };
  writeJson(pkg.packageJsonPath, pkg.manifest);
  return true;
}

function run(command, args) {
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      CI: process.env.CI ?? "true",
      PNPM_CONFIG_CONFIRM_MODULES_PURGE:
        process.env.PNPM_CONFIG_CONFIRM_MODULES_PURGE ?? "false",
    },
  });
  if (result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }
}

export function parseReleaseArgs(argv) {
  const options = {
    dryRun: false,
    skipBuild: false,
    version: undefined,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--help" || arg === "-h" || arg === "help") {
      throw new ReleaseArgError(USAGE);
    }
    if (options.version) {
      throw new ReleaseArgError(`Unexpected argument: ${arg}\n${USAGE}`);
    }
    options.version = arg;
  }

  if (!options.version) {
    throw new ReleaseArgError(`Missing version. Emergency CLI publish must match the GitHub tag.\n${USAGE}`);
  }
  if (!SEMVER_CORE.test(options.version)) {
    throw new ReleaseArgError(
      `Invalid version ${JSON.stringify(options.version)}. Use explicit x.y.z, not patch/minor/major/auto.\n${USAGE}`,
    );
  }

  return options;
}

export class ReleaseArgError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseArgError";
  }
}

export function publishCli(args) {
  const options = parseReleaseArgs(args);
  const pkg = getPackageByName(CLI_PACKAGE_NAME);
  const previous = pkg.manifest.version;
  const next = options.version;
  const changed = writePackageVersion(pkg, next);
  const restoreDryRun = options.dryRun && changed;

  console.log(`${pkg.manifest.name}: ${previous} -> ${next}${options.dryRun ? " (dry-run)" : ""}`);
  try {
    if (!options.skipBuild) run(PNPM_BIN, ["--filter", pkg.manifest.name, "build"]);
    const publishArgs = [
      "--filter",
      pkg.manifest.name,
      "publish",
      "--access",
      "public",
      "--no-git-checks",
    ];
    if (options.dryRun) publishArgs.push("--dry-run");
    run(PNPM_BIN, publishArgs);
  } finally {
    if (restoreDryRun) {
      writePackageVersion(pkg, previous);
      console.log(`Restored dry-run version: ${previous}`);
    }
  }
}

function main() {
  try {
    publishCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ReleaseArgError) fail(error.message);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
