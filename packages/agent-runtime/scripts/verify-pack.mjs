import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const cwd = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "openharness-agent-runtime-pack-"));
const packagesRoot = resolve(cwd, "..");
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("npm_execpath is unavailable");
const npmCli = join(
  dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);

try {
  const workspaceTarballs = workspaceDependencyClosure(cwd).map((packageCwd) =>
    packWorkspacePackage(packageCwd, JSON.parse(
      readFileSync(join(packageCwd, "package.json"), "utf8"),
    ).name.replace("@openharness/", ""))
  );
  const app = join(temp, "consumer.mjs");
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--package-lock=false",
      "--no-save",
      ...workspaceTarballs,
    ],
    {
      cwd: temp,
      stdio: "pipe",
    },
  );

  const installedManifest = JSON.parse(
    readFileSync(
      join(temp, "node_modules", "@openharness", "agent-runtime", "package.json"),
      "utf8",
    ),
  );
  if (JSON.stringify(installedManifest).includes("workspace:")) {
    throw new Error("packed manifest still contains workspace: dependencies");
  }

  writeFileSync(
    app,
    `import {
  createAgentKernel,
  createBasicAgentKernelRuntime,
  createInProcessChildEnvironmentProvider,
} from "@openharness/agent-runtime/kernel";

const defaultEntry = await import("@openharness/agent-runtime");
if (typeof defaultEntry.createDefaultNodeAgent !== "function") {
  throw new Error("packed default Node entry is unavailable");
}

const settings = {
  model: "packed-fake-model",
  apiFormat: "anthropic",
  maxTurns: 5,
  permission: { mode: "default" },
};
const unavailable = (reason) => ({ status: "unavailable", reason });
const capabilities = {
  terminal: unavailable("packed host has no terminal"),
  backgroundShell: unavailable("packed host has no background shell"),
  jobs: unavailable("packed host has no jobs"),
  attachments: unavailable("packed host has no attachments"),
  memory: unavailable("packed host has no memory"),
  childEnvironment: {
    status: "available",
    value: createInProcessChildEnvironmentProvider(),
    source: "override",
  },
  workflowRepository: unavailable("packed host has no workflow repository"),
  imageToText: unavailable("packed host has no image to text"),
  schedules: unavailable("packed host has no schedules"),
};
let rootCalls = 0;
const createRuntime = async (context) => {
  const child = Boolean(context.identity?.childId);
  const client = {
    async *streamMessage() {
      if (child) {
        yield { type: "text_delta", delta: "child complete" };
        yield { type: "complete", stopReason: "end_turn" };
        return;
      }
      rootCalls += 1;
      if (rootCalls === 1) {
        yield {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "spawn-1", name: "SpawnChild", input: {} },
        };
        yield { type: "complete", stopReason: "tool_use" };
        return;
      }
      yield { type: "text_delta", delta: "root complete" };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
  return createBasicAgentKernelRuntime({
    settings,
    cwd: context.cwd,
    sessionId: context.sessionId,
    client,
    tools: child ? [] : [{
      name: "SpawnChild",
      description: "pack verification child",
      inputSchema: {},
      async execute(_input, toolContext) {
        const invocation = await toolContext.agent.children.spawnChildAgent({
          description: "packed child",
          prompt: "run child",
          cwd: context.cwd,
        });
        const result = await invocation.result;
        return { content: [{ type: "text", text: result.output }] };
      },
    }],
  });
};

const agent = await createAgentKernel({
  settings,
  cwd: process.cwd(),
  capabilities,
  effects: {
    requestPermission: async () => ({ status: "approved" }),
  },
  createRuntime,
});
try {
  const result = await agent.runMessage("verify packed root and child");
  if (result.output !== "root complete") throw new Error("packed root did not finish");
  if (!result.history.some((message) => JSON.stringify(message).includes("child complete"))) {
    throw new Error("packed child result did not return to root");
  }
} finally {
  await agent.close();
}
console.log("packed root + child + close: ok");
`,
  );
  execFileSync(process.execPath, [app], {
    cwd: temp,
    stdio: "inherit",
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function packWorkspacePackage(packageCwd, label) {
  const destination = join(temp, `packed-${label}`);
  mkdirSync(destination);
  execFileSync(
    process.execPath,
    [
      pnpmCli,
      "--config.manage-package-manager-versions=false",
      "pack",
      "--pack-destination",
      destination,
    ],
    {
      cwd: packageCwd,
      stdio: "pipe",
      env: { ...process.env, pnpm_config_pm_on_fail: "ignore" },
    },
  );
  const tarballName = readdirSync(destination).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error(`pnpm pack did not create the ${label} tarball`);
  return resolve(destination, tarballName);
}

function workspaceDependencyClosure(rootPackageCwd) {
  const packageDirectories = new Map();
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageCwd = join(packagesRoot, entry.name);
    const manifestPath = join(packageCwd, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name === "string") packageDirectories.set(manifest.name, packageCwd);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const ordered = [];
  const visited = new Set();
  const visit = (packageCwd) => {
    const manifest = JSON.parse(readFileSync(join(packageCwd, "package.json"), "utf8"));
    if (visited.has(manifest.name)) return;
    visited.add(manifest.name);
    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
      if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) continue;
      const dependencyCwd = packageDirectories.get(name);
      if (!dependencyCwd) throw new Error(`Workspace dependency is missing: ${name}`);
      visit(dependencyCwd);
    }
    ordered.push(packageCwd);
  };
  visit(rootPackageCwd);
  return ordered;
}
