import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const WORKSPACE_DIRS = ["apps", "packages"];
const PNPM_BIN = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

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
  const result = spawnSync(command, args, {
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

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log("Usage:");
    console.log("  node scripts/npm-release.mjs plan");
    console.log("  node scripts/npm-release.mjs version patch|minor|major|x.y.z");
    console.log("  node scripts/npm-release.mjs publish [--dry-run]");
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

  fail(`Unknown command: ${command}`);
}

main();
