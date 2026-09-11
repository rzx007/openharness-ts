import { readFile, readdir } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(desktopRoot, "src")
const allowedImports = new Set([
  "@openharness/client",
  "@openharness/server",
  "@openharness/server/daemon-host",
])
const allowedPackageDependencies = new Set(["@openharness/client", "@openharness/server"])
const importPattern =
  /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](@openharness\/[^"']+)["']/g

export function validateDesktopWorkspaceImport(file, specifier) {
  if (!allowedImports.has(specifier)) {
    return `Desktop workspace import is not allowed: ${specifier} (${file})`
  }
  const normalized = file.replaceAll("\\", "/")
  if (specifier.startsWith("@openharness/server") && !normalized.startsWith("src/main/")) {
    return `Desktop server import is only allowed in main: ${specifier} (${file})`
  }
  return null
}

const failures = []
if (!validateDesktopWorkspaceImport("src/main/demo.ts", "@openharness/core")) {
  failures.push("Boundary verifier must reject @openharness/core")
}
if (validateDesktopWorkspaceImport("src/main/demo.ts", "@openharness/server/daemon-host")) {
  failures.push("Boundary verifier must allow daemon-host in main")
}
if (!validateDesktopWorkspaceImport("src/renderer/demo.ts", "@openharness/server")) {
  failures.push("Boundary verifier must reject server in renderer")
}
if (!validateDesktopWorkspaceImport("src/shared/demo.ts", "@openharness/server/daemon-host")) {
  failures.push("Boundary verifier must reject daemon-host outside main")
}
if (!validateDesktopWorkspaceImport("src/main/demo.ts", "@openharness/server/internal")) {
  failures.push("Boundary verifier must reject unknown server subpaths")
}
const packageJson = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"))
for (const section of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  for (const name of Object.keys(packageJson[section] ?? {})) {
    if (name.startsWith("@openharness/") && !allowedPackageDependencies.has(name)) {
      failures.push(`Desktop package dependency is not allowed: ${name} (${section})`)
    }
  }
}

for (const file of await sourceFiles(sourceRoot)) {
  const content = await readFile(file, "utf8")
  for (const match of content.matchAll(importPattern)) {
    const failure = validateDesktopWorkspaceImport(relative(desktopRoot, file), match[1])
    if (failure) failures.push(failure)
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`)
  process.exitCode = 1
} else {
  process.stdout.write("Desktop workspace dependency boundaries verified.\n")
}

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if ([".ts", ".tsx"].includes(extname(entry.name))) files.push(path)
  }
  return files
}
