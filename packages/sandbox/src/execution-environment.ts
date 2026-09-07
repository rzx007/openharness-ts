import type { ChildProcess } from "node:child_process";
import { homedir, platform, tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";

import type { Settings } from "@openharness/core";
import type {
  EffectiveEnvironmentInfo,
  EnvironmentFileSystem,
  EnvironmentPathOperation,
  EnvironmentPathResolver,
  EnvironmentProcess,
  EnvironmentProcessExecutor,
  EnvironmentTerminalFactory,
  ExecutionEnvironmentHandle,
  ExecutionEnvironmentIdentity,
  ResolvedEnvironmentPath,
  WorkspaceBinding,
} from "@openharness/environment";

import type { ResolvedExecutionEnvironmentConfig } from "./execution-config.js";
import {
  prepareDesktopManagedMounts,
  type ManagedDockerMount,
} from "./managed-mounts.js";
import { signalProcessTree } from "./process-control.js";
import {
  createProcess,
  createShellProcess,
  describeHostShellLauncher,
  resolveHostShellLauncher,
} from "./shell.js";
import {
  startSandboxRuntime,
  type SandboxRuntimeOptions,
  type StartedSandboxRuntime,
} from "./lifecycle.js";

export interface CreateExecutionEnvironmentInput {
  config: ResolvedExecutionEnvironmentConfig;
  settings: Settings;
  binding: WorkspaceBinding;
  sessionId: string;
  userSkillsRoot: string;
  identity?: ExecutionEnvironmentIdentity;
  onEvent?: (event: "preflight" | "start" | "probe" | "ready") => void;
}

export interface CreateExecutionEnvironmentDependencies {
  startSandboxRuntime?: (
    input: SandboxRuntimeOptions,
  ) => Promise<StartedSandboxRuntime>;
  createShellProcess?: typeof createShellProcess;
  createProcess?: typeof createProcess;
}

export async function createExecutionEnvironment(
  input: CreateExecutionEnvironmentInput,
  dependencies: CreateExecutionEnvironmentDependencies = {},
): Promise<ExecutionEnvironmentHandle> {
  input.onEvent?.("preflight");
  if (input.config.mode === "legacy_srt") {
    throw new Error("Legacy SRT is not an ExecutionEnvironment backend");
  }
  if (input.config.kind === "local") {
    input.onEvent?.("probe");
    const handle = createLocalHandle(input, dependencies);
    input.onEvent?.("ready");
    return handle;
  }

  const managedMounts = await prepareDesktopManagedMounts({
    workspaceRoot: input.binding.hostRoot,
    userSkillsRoot: input.userSkillsRoot,
  });
  input.onEvent?.("start");
  const runtime = await (
    dependencies.startSandboxRuntime ?? startSandboxRuntime
  )({
    settings: { ...input.settings, sandbox: input.config.sandbox },
    cwd: input.binding.hostRoot,
    sessionId: input.sessionId,
    managedMounts,
    identity: input.identity,
  });
  if (!runtime.status.active || runtime.status.backend !== "docker") {
    await runtime.stop();
    throw new Error(
      runtime.status.reason ?? "Docker execution environment is unavailable",
    );
  }
  input.onEvent?.("probe");
  const handle = createDockerHandle(
    input,
    dependencies,
    runtime,
    managedMounts,
  );
  input.onEvent?.("ready");
  return handle;
}

function createLocalHandle(
  input: CreateExecutionEnvironmentInput,
  dependencies: CreateExecutionEnvironmentDependencies,
): ExecutionEnvironmentHandle {
  const shell = resolveHostShellLauncher();
  return {
    info: {
      kind: "local",
      hostOs: hostOsName(),
      executionOs: hostOsName(),
      shell: describeHostShellLauncher(shell),
      shellDialect: shell.kind === "powershell"
        ? "powershell"
        : shell.kind === "cmd"
          ? "cmd"
          : "posix",
      pathStyle: platform() === "win32" ? "windows" : "posix",
      cwd: input.binding.executionRoot,
      homeDir: homedir(),
      tempDir: tmpdir(),
      mounts: [{
        path: input.binding.executionRoot,
        mode: "rw",
        purpose: "workspace",
      }],
      networkMode: "host",
      limitations: [],
    },
    workspace: input.binding,
    process: createProcessExecutor(input, dependencies),
    terminal: createLocalTerminalFactory(input),
    files: unavailableFileSystem(),
    paths: createPathResolver(input.binding, []),
    async release() {},
  };
}

function createDockerHandle(
  input: CreateExecutionEnvironmentInput,
  dependencies: CreateExecutionEnvironmentDependencies,
  runtime: StartedSandboxRuntime,
  managedMounts: ManagedDockerMount[],
): ExecutionEnvironmentHandle {
  let released = false;
  return {
    info: {
      kind: "docker",
      hostOs: hostOsName(runtime.status.platform),
      executionOs: "Linux",
      shell: "/bin/sh",
      shellDialect: "posix",
      pathStyle: "posix",
      cwd: input.binding.executionRoot,
      homeDir: "/root",
      tempDir: "/tmp",
      mounts: managedMounts.map((mount) => ({
        path: mount.target,
        mode: mount.mode,
        purpose: mount.purpose,
      })),
      networkMode:
        runtime.status.networkMode ?? input.config.sandbox.network.mode,
      limitations: [
        "Host paths outside the effective mount list are unavailable",
      ],
    },
    workspace: input.binding,
    process: createProcessExecutor(input, dependencies, runtime),
    terminal: createDockerTerminalFactory(input, runtime, managedMounts),
    files: unavailableFileSystem(),
    paths: createPathResolver(input.binding, managedMounts),
    async release() {
      if (released) return;
      released = true;
      await runtime.stop();
    },
  };
}

function createLocalTerminalFactory(
  input: CreateExecutionEnvironmentInput,
): EnvironmentTerminalFactory {
  return {
    async prepare(options) {
      const launcher = resolveHostShellLauncher();
      const command = options.shell?.trim() || input.settings.terminal?.localShell ||
        (launcher.kind === "posix-sh" ? "/bin/sh" : launcher.bin);
      return {
        command,
        args: [],
        hostCwd: options.cwd ?? input.binding.hostRoot,
        executionCwd: options.cwd ?? input.binding.executionRoot,
        shell: command,
        async signal() {},
        async close() {},
      };
    },
  };
}

function createDockerTerminalFactory(
  input: CreateExecutionEnvironmentInput,
  runtime: StartedSandboxRuntime,
  mounts: readonly ManagedDockerMount[],
): EnvironmentTerminalFactory {
  const paths = createPathResolver(input.binding, mounts);
  return {
    async prepare(options) {
      const resolved = await paths.resolve(
        options.cwd ?? input.binding.executionRoot,
        "execute",
      );
      if (resolved.mountPurpose === "unmounted") {
        throw new Error(`Terminal cwd is outside the mounted execution roots: ${resolved.executionPath}`);
      }
      const shell = options.shell ?? input.settings.terminal?.dockerShell ?? "/bin/sh";
      if (shell !== "/bin/sh" && shell !== "/bin/bash") {
        throw new Error(`docker_terminal_shell_unavailable: ${shell}`);
      }
      if (!runtime.session?.preparePtyTarget) {
        throw new Error("Docker execution environment does not provide PTY support");
      }
      return runtime.session.preparePtyTarget({
        ...options,
        cwd: resolved.executionPath,
        shell,
      });
    },
  };
}

function createProcessExecutor(
  input: CreateExecutionEnvironmentInput,
  dependencies: CreateExecutionEnvironmentDependencies,
  runtime?: StartedSandboxRuntime,
): EnvironmentProcessExecutor {
  const settings = {
    ...input.settings,
    sandbox: input.config.sandbox,
  };
  return {
    async execShell(command, options = {}) {
      if (runtime?.session?.execCommand) {
        const child = await runtime.session.execCommand(
          ["/bin/sh", "-c", command],
          {
            cwd: options.cwd ?? input.binding.executionRoot,
            settings,
            env: options.env,
            signal: options.signal,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        return adaptChildProcess(child);
      }
      const child = await (
        dependencies.createShellProcess ?? createShellProcess
      )(command, {
        cwd: input.binding.hostRoot,
        sessionId: input.sessionId,
        settings,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return adaptChildProcess(child);
    },
    async execProcess(argv, options = {}) {
      if (runtime?.session?.execCommand) {
        const child = await runtime.session.execCommand(argv, {
          cwd: options.cwd ?? input.binding.executionRoot,
          settings,
          env: options.env,
          signal: options.signal,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return adaptChildProcess(child);
      }
      const child = await (
        dependencies.createProcess ?? createProcess
      )(argv, {
        cwd: input.binding.hostRoot,
        sessionId: input.sessionId,
        settings,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return adaptChildProcess(child);
    },
  };
}

function adaptChildProcess(child: ChildProcess): EnvironmentProcess {
  const outputListeners = new Set<(chunk: Uint8Array) => void>();
  const emit = (chunk: Buffer) => {
    for (const listener of outputListeners) listener(chunk);
  };
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);
  const result = new Promise<{ exitCode: number | null; signal?: string }>(
    (resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        resolveResult({
          exitCode,
          ...(signal ? { signal } : {}),
        });
      });
    },
  );
  return {
    ...(child.pid ? { pid: child.pid } : {}),
    write(data) {
      child.stdin?.write(data);
    },
    end() {
      child.stdin?.end();
    },
    onOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    wait: () => result,
    async signal(signal) {
      signalProcessTree(
        child,
        signal === "interrupt" ? "SIGINT" : "SIGKILL",
      );
    },
  };
}

function createPathResolver(
  binding: WorkspaceBinding,
  mounts: readonly ManagedDockerMount[],
): EnvironmentPathResolver {
  if (binding.kind === "local") {
    return {
      async resolve(path) {
        const executionPath = isAbsolute(path)
          ? resolve(path)
          : resolve(binding.executionRoot, path);
        return {
          executionPath,
          hostPath: executionPath,
          mountPurpose: "workspace",
          mountMode: "rw",
        };
      },
      presentHostPath: (path) => resolve(path),
      toHostPath: (path) => resolve(path),
    };
  }
  const resolveDockerPath = (path: string) =>
    posix.resolve(binding.executionRoot, path);
  const matchMount = (path: string) =>
    mounts.find(
      (mount) =>
        path === mount.target || path.startsWith(`${mount.target}/`),
    );
  const toHostPath = (path: string) => {
    const executionPath = resolveDockerPath(path);
    const mount = matchMount(executionPath);
    if (!mount) return undefined;
    const rel = posix.relative(mount.target, executionPath);
    return rel ? join(mount.source, ...rel.split("/")) : mount.source;
  };
  return {
    async resolve(
      path,
      _operation: EnvironmentPathOperation,
    ): Promise<ResolvedEnvironmentPath> {
      if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
        return {
          executionPath: path,
          mountPurpose: "unmounted",
        };
      }
      const executionPath = resolveDockerPath(path);
      const mount = matchMount(executionPath);
      return {
        executionPath,
        ...(mount ? { hostPath: toHostPath(executionPath) } : {}),
        mountPurpose:
          mount?.purpose === "workspace" || mount?.purpose === "user_skills"
            ? mount.purpose
            : "unmounted",
        ...(mount ? { mountMode: mount.mode } : {}),
      };
    },
    presentHostPath(path) {
      const hostPath = resolve(path);
      const mount = mounts.find((candidate) => {
        const rel = relative(candidate.source, hostPath);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      });
      if (!mount) return undefined;
      const rel = relative(mount.source, hostPath).replace(/\\/g, "/");
      return rel ? posix.join(mount.target, rel) : mount.target;
    },
    toHostPath,
  };
}

function unavailableFileSystem(): EnvironmentFileSystem {
  const unavailable = async (): Promise<never> => {
    throw new Error("Environment file operations are not configured");
  };
  return {
    stat: unavailable,
    listDir: unavailable,
    readText: unavailable,
    readBytes: unavailable,
    writeText: unavailable,
    writeBytes: unavailable,
    glob: unavailable,
    grep: unavailable,
  };
}

function hostOsName(sandboxPlatform?: string): string {
  if (sandboxPlatform === "windows" || platform() === "win32") return "Windows";
  if (sandboxPlatform === "macos" || platform() === "darwin") return "macOS";
  return "Linux";
}
