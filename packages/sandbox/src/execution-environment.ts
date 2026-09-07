import type { ChildProcess } from "node:child_process";
import { homedir, platform, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Settings } from "@openharness/core";
import type {
  EnvironmentFileSystem,
  EnvironmentPathResolver,
  EnvironmentProcess,
  EnvironmentProcessExecutor,
  EnvironmentTerminalFactory,
  ExecutionEnvironmentHandle,
  WorkspaceBinding,
} from "@openharness/environment";
import type { ResolvedExecutionEnvironmentConfig } from "./execution-config.js";
import { signalProcessTree } from "./process-control.js";
import { createProcess, createShellProcess, describeHostShellLauncher, resolveHostShellLauncher } from "./shell.js";
import { createWslPathResolver, preflightWsl, spawnWslProcess } from "./wsl-environment.js";

export interface CreateExecutionEnvironmentInput {
  config: ResolvedExecutionEnvironmentConfig;
  settings: Settings;
  binding: WorkspaceBinding;
  sessionId: string;
  userSkillsRoot: string;
  onEvent?: (event: "preflight" | "probe" | "ready") => void;
}

export interface CreateExecutionEnvironmentDependencies {
  createShellProcess?: typeof createShellProcess;
  createProcess?: typeof createProcess;
  preflightWsl?: typeof preflightWsl;
  spawnWslProcess?: typeof spawnWslProcess;
}

export async function createExecutionEnvironment(
  input: CreateExecutionEnvironmentInput,
  dependencies: CreateExecutionEnvironmentDependencies = {},
): Promise<ExecutionEnvironmentHandle> {
  input.onEvent?.("preflight");
  if (input.config.kind === "wsl") {
    await (dependencies.preflightWsl ?? preflightWsl)();
    input.onEvent?.("probe");
    const handle = createWslHandle(input, dependencies);
    input.onEvent?.("ready");
    return handle;
  }
  input.onEvent?.("probe");
  const handle = createLocalHandle(input, dependencies);
  input.onEvent?.("ready");
  return handle;
}

function createWslHandle(input: CreateExecutionEnvironmentInput, dependencies: CreateExecutionEnvironmentDependencies): ExecutionEnvironmentHandle {
  const paths = createWslPathResolver(input.binding);
  return {
    info: {
      kind: "wsl", hostOs: "Windows", executionOs: "Linux", shell: "/bin/sh",
      shellDialect: "posix", pathStyle: "posix", cwd: input.binding.executionRoot,
      homeDir: "/home", tempDir: "/tmp",
      mounts: [{ path: input.binding.executionRoot, mode: "rw", purpose: "workspace" }],
      networkMode: "host", limitations: ["WSL filesystem project roots are not supported yet"],
    },
    workspace: input.binding,
    process: createWslProcessExecutor(input, dependencies),
    terminal: {
      async prepare(options) {
        const cwd = (await paths.resolve(options.cwd ?? input.binding.executionRoot, "execute")).executionPath;
        return {
          command: "wsl.exe", args: ["--cd", cwd], hostCwd: input.binding.hostRoot,
          executionCwd: cwd, shell: "default", async signal() {}, async close() {},
        };
      },
    },
    files: unavailableFileSystem(), paths, async release() {},
  };
}

function createWslProcessExecutor(input: CreateExecutionEnvironmentInput, dependencies: CreateExecutionEnvironmentDependencies): EnvironmentProcessExecutor {
  const run = dependencies.spawnWslProcess ?? spawnWslProcess;
  return {
    async execShell(command, options = {}) {
      return adaptChildProcess(run({ argv: ["/bin/sh", "-lc", command], cwd: options.cwd ?? input.binding.executionRoot, env: options.env }));
    },
    async execProcess(argv, options = {}) {
      return adaptChildProcess(run({ argv, cwd: options.cwd ?? input.binding.executionRoot, env: options.env }));
    },
  };
}

function createLocalHandle(input: CreateExecutionEnvironmentInput, dependencies: CreateExecutionEnvironmentDependencies): ExecutionEnvironmentHandle {
  const shell = resolveHostShellLauncher();
  return {
    info: {
      kind: "local", hostOs: hostOsName(), executionOs: hostOsName(),
      shell: describeHostShellLauncher(shell),
      shellDialect: shell.kind === "powershell" ? "powershell" : shell.kind === "cmd" ? "cmd" : "posix",
      pathStyle: platform() === "win32" ? "windows" : "posix", cwd: input.binding.executionRoot,
      homeDir: homedir(), tempDir: tmpdir(),
      mounts: [{ path: input.binding.executionRoot, mode: "rw", purpose: "workspace" }],
      networkMode: "host", limitations: [],
    },
    workspace: input.binding,
    process: createLocalProcessExecutor(input, dependencies),
    terminal: createLocalTerminalFactory(input), files: unavailableFileSystem(),
    paths: createLocalPathResolver(input.binding), async release() {},
  };
}

function createLocalTerminalFactory(input: CreateExecutionEnvironmentInput): EnvironmentTerminalFactory {
  return { async prepare(options) {
    const launcher = resolveHostShellLauncher();
    const command = options.shell?.trim() || input.settings.terminal?.localShell || (launcher.kind === "posix-sh" ? "/bin/sh" : launcher.bin);
    return { command, args: [], hostCwd: options.cwd ?? input.binding.hostRoot, executionCwd: options.cwd ?? input.binding.executionRoot, shell: command, async signal() {}, async close() {} };
  } };
}

function createLocalProcessExecutor(input: CreateExecutionEnvironmentInput, dependencies: CreateExecutionEnvironmentDependencies): EnvironmentProcessExecutor {
  return {
    async execShell(command, options = {}) {
      return adaptChildProcess(await (dependencies.createShellProcess ?? createShellProcess)(command, {
        cwd: input.binding.hostRoot, sessionId: input.sessionId, settings: input.settings,
        env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"],
      }));
    },
    async execProcess(argv, options = {}) {
      return adaptChildProcess(await (dependencies.createProcess ?? createProcess)(argv, {
        cwd: input.binding.hostRoot, sessionId: input.sessionId, settings: input.settings,
        env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"],
      }));
    },
  };
}

function adaptChildProcess(child: ChildProcess): EnvironmentProcess {
  const listeners = new Set<(chunk: Uint8Array) => void>();
  const emit = (chunk: Buffer) => { for (const listener of listeners) listener(chunk); };
  child.stdout?.on("data", emit); child.stderr?.on("data", emit);
  const result = new Promise<{ exitCode: number | null; signal?: string }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveResult({ exitCode, ...(signal ? { signal } : {}) }));
  });
  return {
    ...(child.pid ? { pid: child.pid } : {}), write: (data) => { child.stdin?.write(data); },
    end: () => { child.stdin?.end(); }, onOutput(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    wait: () => result, async signal(signal) { signalProcessTree(child, signal === "interrupt" ? "SIGINT" : "SIGKILL"); },
  };
}

function createLocalPathResolver(binding: WorkspaceBinding): EnvironmentPathResolver {
  return {
    async resolve(path) {
      const executionPath = isAbsolute(path) ? resolve(path) : resolve(binding.executionRoot, path);
      return { executionPath, hostPath: executionPath, mountPurpose: "workspace", mountMode: "rw" };
    },
    presentHostPath: (path) => resolve(path), toHostPath: (path) => resolve(path),
  };
}

function unavailableFileSystem(): EnvironmentFileSystem {
  const unavailable = async (): Promise<never> => { throw new Error("Environment file operations are not configured"); };
  return { stat: unavailable, listDir: unavailable, readText: unavailable, readBytes: unavailable, writeText: unavailable, writeBytes: unavailable, glob: unavailable, grep: unavailable };
}

function hostOsName(): string {
  if (platform() === "win32") return "Windows";
  if (platform() === "darwin") return "macOS";
  return "Linux";
}
