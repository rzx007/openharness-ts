import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const WORKSPACE_DIRS = ["apps", "packages"];
const PNPM_BIN = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";
const CLI_PACKAGE_NAME = "@rzx/ohs";

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

function getPublishablePackages() {
  return discoverWorkspacePackages().filter((pkg) => pkg.manifest.private !== true);
}

function ensureSingleVersion(packages) {
  const versions = [...new Set(packages.map((pkg) => pkg.manifest.version).filter(Boolean))];
  if (versions.length !== 1) {
    fail(`Expected a single workspace version, found: ${versions.join(", ")}`);
  }
  return versions[0];
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail(`Unsupported version format: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function computeNextVersion(currentVersion, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const { major, minor, patch } = parseVersion(currentVersion);
  switch (spec) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      fail(`Unsupported release spec: ${spec}. Use patch, minor, major, or an explicit x.y.z version.`);
  }
}

function getInternalDeps(pkg, packageNameSet) {
  const manifest = pkg.manifest;
  const sections = [
    manifest.dependencies ?? {},
    manifest.optionalDependencies ?? {},
  ];
  const deps = new Set();
  for (const section of sections) {
    for (const depName of Object.keys(section)) {
      if (packageNameSet.has(depName)) deps.add(depName);
    }
  }
  return deps;
}

function topoSortPackages(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const packageNames = new Set(byName.keys());
  const depsByName = new Map();
  const dependentsByName = new Map();
  const indegree = new Map();

  for (const pkg of packages) {
    const name = pkg.manifest.name;
    const deps = getInternalDeps(pkg, packageNames);
    depsByName.set(name, deps);
    indegree.set(name, deps.size);
    for (const dep of deps) {
      const set = dependentsByName.get(dep) ?? new Set();
      set.add(name);
      dependentsByName.set(dep, set);
    }
  }

  const queue = [...packages]
    .map((pkg) => pkg.manifest.name)
    .filter((name) => (indegree.get(name) ?? 0) === 0)
    .sort();
  const ordered = [];

  while (queue.length > 0) {
    const name = queue.shift();
    ordered.push(byName.get(name));
    for (const dependent of dependentsByName.get(name) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        queue.push(dependent);
        queue.sort();
      }
    }
  }

  if (ordered.length !== packages.length) {
    const unresolved = packages
      .map((pkg) => pkg.manifest.name)
      .filter((name) => !ordered.some((pkg) => pkg.manifest.name === name));
    fail(`Failed to compute publish order. Check for cyclic workspace deps: ${unresolved.join(", ")}`);
  }

  return ordered;
}

function run(command, args, options = {}) {
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
    ...options,
  });
  if (result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function capture(command, args) {
  const invocation = commandInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return 0;
}

function getPackageByName(name) {
  const pkg = discoverWorkspacePackages().find((item) => item.manifest.name === name);
  if (!pkg) fail(`Workspace package not found: ${name}`);
  return pkg;
}

function latestPublishedVersion(packageName) {
  const result = capture(NPM_BIN, ["view", packageName, "version", "--json"]);
  if (result.error) fail(`Failed to run npm view: ${result.error.message}`);
  if (result.status === 0) {
    const output = (result.stdout ?? "").trim();
    if (!output) return undefined;
    const parsed = JSON.parse(output);
    return typeof parsed === "string" ? parsed : undefined;
  }
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (combined.includes("E404") || combined.includes("404 Not Found")) return undefined;
  if (result.stderr) process.stderr.write(result.stderr);
  fail(`Failed to read published version for ${packageName}`);
}

function resolvePackageVersion(pkg, spec = "auto") {
  if (spec !== "auto") return computeNextVersion(pkg.manifest.version, spec);
  const latest = latestPublishedVersion(pkg.manifest.name);
  if (!latest) return pkg.manifest.version;
  if (compareVersions(pkg.manifest.version, latest) > 0) return pkg.manifest.version;
  return computeNextVersion(latest, "patch");
}

function writePackageVersion(pkg, version) {
  if (pkg.manifest.version === version) return false;
  pkg.manifest = { ...pkg.manifest, version };
  writeJson(pkg.packageJsonPath, pkg.manifest);
  return true;
}

function printPlan(packages) {
  const version = ensureSingleVersion(packages);
  const ordered = topoSortPackages(packages);
  console.log(`Current workspace version: ${version}`);
  console.log(`Publishable packages: ${packages.length}`);
  console.log("");
  console.log("Publish order:");
  for (const pkg of ordered) {
    console.log(`- ${pkg.manifest.name}  (${pkg.dir.replace(`${ROOT}\\`, "").replace(`${ROOT}/`, "")})`);
  }
}

function bumpVersions(spec) {
  const packages = getPublishablePackages();
  const currentVersion = ensureSingleVersion(packages);
  const nextVersion = computeNextVersion(currentVersion, spec);
  let changed = 0;

  for (const pkg of packages) {
    if (pkg.manifest.version === nextVersion) continue;
    const manifest = { ...pkg.manifest, version: nextVersion };
    writeJson(pkg.packageJsonPath, manifest);
    changed += 1;
  }

  console.log(
    `Bumped ${changed} packages: ${currentVersion} -> ${nextVersion}`
  );
}

function publishPackages(args) {
  const packages = getPublishablePackages();
  const version = ensureSingleVersion(packages);
  const ordered = topoSortPackages(packages);
  const dryRun = args.includes("--dry-run");

  console.log(`Publishing ${ordered.length} packages at version ${version}${dryRun ? " (dry-run)" : ""}`);
  run(PNPM_BIN, ["build"]);

  for (const pkg of ordered) {
    const publishArgs = [
      "--filter",
      pkg.manifest.name,
      "publish",
      "--access",
      "public",
      "--no-git-checks",
    ];
    if (dryRun) publishArgs.push("--dry-run");
    console.log(`\n==> ${pkg.manifest.name}`);
    run(PNPM_BIN, publishArgs);
  }
}

function parseCliOptions(args) {
  const options = {
    dryRun: false,
    skipBuild: false,
    spec: "auto",
  };
  for (const arg of args) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (options.spec === "auto") options.spec = arg;
    else fail(`Unexpected argument: ${arg}`);
  }
  return options;
}

function printCliPlan() {
  const pkg = getPackageByName(CLI_PACKAGE_NAME);
  const latest = latestPublishedVersion(pkg.manifest.name);
  const next = resolvePackageVersion(pkg, "auto");
  console.log(`Package: ${pkg.manifest.name}`);
  console.log(`Local version: ${pkg.manifest.version}`);
  console.log(`Published latest: ${latest ?? "(not published)"}`);
  console.log(`Next auto version: ${next}`);
  console.log("");
  console.log("Root commands:");
  console.log("  pnpm release:cli:dry");
  console.log("  pnpm release:cli");
  console.log("  pnpm release:cli -- minor");
  console.log("  pnpm release:cli -- 0.2.0");
}

function versionCli(args) {
  const { spec } = parseCliOptions(args);
  const pkg = getPackageByName(CLI_PACKAGE_NAME);
  const next = resolvePackageVersion(pkg, spec);
  const previous = pkg.manifest.version;
  const changed = writePackageVersion(pkg, next);
  console.log(`${pkg.manifest.name}: ${previous} -> ${next}${changed ? "" : " (unchanged)"}`);
}

function publishCli(args) {
  const options = parseCliOptions(args);
  const pkg = getPackageByName(CLI_PACKAGE_NAME);
  const previous = pkg.manifest.version;
  const next = resolvePackageVersion(pkg, options.spec);
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
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log("Usage:");
    console.log("  node scripts/npm-release.mjs plan");
    console.log("  node scripts/npm-release.mjs version patch|minor|major|x.y.z");
    console.log("  node scripts/npm-release.mjs publish [--dry-run]");
    console.log("  node scripts/npm-release.mjs cli-plan");
    console.log("  node scripts/npm-release.mjs cli-version [auto|patch|minor|major|x.y.z]");
    console.log("  node scripts/npm-release.mjs cli-publish [auto|patch|minor|major|x.y.z] [--dry-run] [--skip-build]");
    process.exit(0);
  }

  if (command === "plan") {
    printPlan(getPublishablePackages());
    return;
  }

  if (command === "version") {
    const spec = rest[0];
    if (!spec) fail("Missing version spec. Use patch, minor, major, or explicit x.y.z.");
    bumpVersions(spec);
    return;
  }

  if (command === "publish") {
    publishPackages(rest);
    return;
  }

  if (command === "cli-plan") {
    printCliPlan();
    return;
  }

  if (command === "cli-version") {
    versionCli(rest);
    return;
  }

  if (command === "cli-publish") {
    publishCli(rest);
    return;
  }

  fail(`Unknown command: ${command}`);
}

main();
