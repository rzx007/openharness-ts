import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";

import { loadSettings } from "@openharness/core";
import {
  createShellProcess,
  startSandboxRuntime,
  type StartedSandboxRuntime,
} from "@openharness/sandbox";
import type {
  TerminalCreateRequest,
  TerminalProvider,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalSignalRequest,
  TerminalWriteRequest,
} from "@openharness/terminal";
import {
  TerminalEventBus,
  type TerminalEventListener,
} from "@openharness/terminal";
import type { IPty } from "node-pty";

import { OutputBuffer } from "./output-buffer";
import { createTerminalEnv, resolveDefaultShell } from "./shell";
import { TerminalOutputStore } from "./terminal-output-store";

export interface LocalTerminalProviderOptions {
  resolveCwd: (input: TerminalCreateRequest) => Promise<string>;
}

interface LocalTerminalSession {
  info: TerminalSessionInfo;
  kind: "pty";
  pty: IPty | null;
  output: OutputBuffer;
  transcript: TerminalOutputStore;
}

interface SandboxTerminalSession {
  info: TerminalSessionInfo;
  kind: "process";
  child: ChildProcess | null;
  runtime: StartedSandboxRuntime;
  output: OutputBuffer;
  transcript: TerminalOutputStore;
}

type TerminalSession = LocalTerminalSession | SandboxTerminalSession;

export class LocalTerminalProvider implements TerminalProvider {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly events = new TerminalEventBus();

  constructor(private readonly options: LocalTerminalProviderOptions) {}

  async create(input: TerminalCreateRequest): Promise<TerminalSessionInfo> {
    const cwd = await this.options.resolveCwd(input);
    await requireDirectory(cwd);

    if (input.runtime === "sandbox") return await this.createSandboxTerminal(input, cwd);
    if (input.runtime !== "local")
      throw new Error(`Unsupported terminal runtime: ${input.runtime}`);

    return await this.createLocalTerminal(input, cwd);
  }

  private async createLocalTerminal(
    input: TerminalCreateRequest,
    cwd: string,
  ): Promise<TerminalSessionInfo> {
    const id = randomUUID();
    const shell = input.shell?.trim() || resolveDefaultShell().command;
    const { spawn } = await import("node-pty");
    const pty = spawn(shell, [], {
      cwd,
      cols: clampDimension(input.cols),
      rows: clampDimension(input.rows),
      env: createTerminalEnv(),
      name: "xterm-256color",
    });
    const transcript = new TerminalOutputStore();
    const output = new OutputBuffer((data) => {
      const snapshot = transcript.append(id, data);
      this.events.emit({
        type: "data",
        terminalId: id,
        data,
        sequence: snapshot.sequence,
      });
    });
    const info: TerminalSessionInfo = {
      id,
      name: normalizeTerminalName(input.name),
      projectId: input.projectId,
      runtime: "local",
      source: input.source ?? "user",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      status: "running",
      cwd,
      shell,
      cols: clampDimension(input.cols),
      rows: clampDimension(input.rows),
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(id, { info, kind: "pty", pty, output, transcript });

    pty.onData((data) => output.push(data));
    pty.onExit(({ exitCode }) => {
      output.dispose();
      const session = this.sessions.get(id);
      if (!session || session.kind !== "pty") return;
      session.pty = null;
      session.info = {
        ...session.info,
        status: "exited",
        exitedAt: new Date().toISOString(),
        exitCode,
      };
      this.events.emit({ type: "exit", terminalId: id, exitCode });
    });

    return info;
  }

  private async createSandboxTerminal(
    input: TerminalCreateRequest,
    cwd: string,
  ): Promise<TerminalSessionInfo> {
    const id = randomUUID();
    const settings = await loadSettings(undefined, {
      projectRoot: cwd,
      includeProject: true,
    });
    const sandboxSettings = {
      ...settings,
      sandbox: {
        ...settings.sandbox,
        enabled: true,
        failIfUnavailable: true,
      },
    };
    const runtime = await startSandboxRuntime({
      settings: sandboxSettings,
      cwd,
      sessionId: id,
    });
    const shell = input.shell?.trim() || defaultSandboxShellCommand();

    try {
      const child = await createShellProcess(shell, {
        cwd,
        sessionId: id,
        settings: sandboxSettings,
        env: definedEnv(createTerminalEnv()),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const transcript = new TerminalOutputStore();
      const output = new OutputBuffer((data) => {
        const snapshot = transcript.append(id, data);
        this.events.emit({
          type: "data",
          terminalId: id,
          data,
          sequence: snapshot.sequence,
        });
      });
      const info: TerminalSessionInfo = {
        id,
        name: normalizeTerminalName(input.name),
        projectId: input.projectId,
        runtime: "sandbox",
        source: input.source ?? "user",
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        status: "running",
        cwd,
        shell,
        cols: clampDimension(input.cols),
        rows: clampDimension(input.rows),
        createdAt: new Date().toISOString(),
      };

      this.sessions.set(id, { info, kind: "process", child, runtime, output, transcript });

      child.stdout?.on("data", (data) => output.push(data.toString()));
      child.stderr?.on("data", (data) => output.push(data.toString()));
      child.on("error", (error) => output.push(`\r\n${error.message}\r\n`));
      child.on("close", (exitCode) => {
        output.dispose();
        const session = this.sessions.get(id);
        if (!session || session.kind !== "process") return;
        session.child = null;
        session.info = {
          ...session.info,
          status: "exited",
          exitedAt: new Date().toISOString(),
          exitCode,
        };
        void session.runtime.stop().catch(() => {});
        this.events.emit({ type: "exit", terminalId: id, exitCode });
      });

      return info;
    } catch (error) {
      await runtime.stop().catch(() => {});
      throw error;
    }
  }

  async write(input: TerminalWriteRequest): Promise<void> {
    const session = this.requireRunningSession(input.terminalId);
    if (session.kind === "pty") session.pty.write(input.data);
    else session.child.stdin?.write(input.data);
  }

  async resize(input: TerminalResizeRequest): Promise<void> {
    const session = this.requireRunningSession(input.terminalId);
    const cols = clampDimension(input.cols);
    const rows = clampDimension(input.rows);
    if (session.kind === "pty") session.pty.resize(cols, rows);
    session.info = { ...session.info, cols, rows };
  }

  async read(input: TerminalReadRequest): Promise<TerminalReadResult> {
    const session = this.requireSession(input.terminalId);
    session.output.drain();
    return session.transcript.read(input.terminalId);
  }

  async signal(input: TerminalSignalRequest): Promise<void> {
    if (input.signal === "terminate") {
      await this.kill(input.terminalId);
      return;
    }
    const session = this.requireRunningSession(input.terminalId);
    if (session.kind === "pty") {
      session.pty.write(input.signal === "interrupt" ? "\x03" : "\x04");
      return;
    }
    if (input.signal === "interrupt") session.child.kill("SIGINT");
    else session.child.stdin?.end();
  }

  async kill(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.output.dispose();
    this.sessions.delete(terminalId);
    if (session.kind === "pty") {
      session.pty?.kill();
    } else {
      session.child?.kill();
      await session.runtime.stop().catch(() => {});
    }
  }

  async list(): Promise<TerminalSessionInfo[]> {
    return [...this.sessions.values()].map((session) => session.info);
  }

  subscribe(listener: TerminalEventListener): () => void {
    return this.events.subscribe(listener);
  }

  async dispose(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
    this.events.clear();
  }

  private requireSession(terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session) throw new Error(`Terminal ${terminalId} does not exist.`);
    return session;
  }

  private requireRunningSession(
    terminalId: string,
  ): (LocalTerminalSession & { pty: IPty }) | (SandboxTerminalSession & { child: ChildProcess }) {
    const session = this.requireSession(terminalId);
    if (
      session.info.status !== "running" ||
      (session.kind === "pty" && !session.pty) ||
      (session.kind === "process" && !session.child)
    ) {
      throw new Error(`Terminal ${terminalId} is no longer running.`);
    }
    return session as
      | (LocalTerminalSession & { pty: IPty })
      | (SandboxTerminalSession & { child: ChildProcess });
  }
}

function normalizeTerminalName(value?: string): string {
  const name = value?.trim();
  return name ? name.slice(0, 80) : "Terminal";
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return 80;
  return Math.max(1, Math.min(Math.round(value), 1_000));
}

function defaultSandboxShellCommand(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh -i";
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function requireDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error("Terminal cwd must be a directory.");
}
