import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

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
  pty: IPty | null;
  output: OutputBuffer;
  transcript: TerminalOutputStore;
}

export class LocalTerminalProvider implements TerminalProvider {
  private readonly sessions = new Map<string, LocalTerminalSession>();
  private readonly events = new TerminalEventBus();

  constructor(private readonly options: LocalTerminalProviderOptions) {}

  async create(input: TerminalCreateRequest): Promise<TerminalSessionInfo> {
    if (input.runtime !== "local")
      throw new Error(`Unsupported terminal runtime: ${input.runtime}`);

    const cwd = await this.options.resolveCwd(input);
    await requireDirectory(cwd);

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

    this.sessions.set(id, { info, pty, output, transcript });

    pty.onData((data) => output.push(data));
    pty.onExit(({ exitCode }) => {
      output.dispose();
      const session = this.sessions.get(id);
      if (!session) return;
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

  async write(input: TerminalWriteRequest): Promise<void> {
    this.requireRunningSession(input.terminalId).pty.write(input.data);
  }

  async resize(input: TerminalResizeRequest): Promise<void> {
    const session = this.requireRunningSession(input.terminalId);
    const cols = clampDimension(input.cols);
    const rows = clampDimension(input.rows);
    session.pty.resize(cols, rows);
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
    session.pty.write(input.signal === "interrupt" ? "\x03" : "\x04");
  }

  async kill(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.output.dispose();
    this.sessions.delete(terminalId);
    session.pty?.kill();
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

  private requireSession(terminalId: string): LocalTerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session) throw new Error(`Terminal ${terminalId} does not exist.`);
    return session;
  }

  private requireRunningSession(
    terminalId: string,
  ): LocalTerminalSession & { pty: IPty } {
    const session = this.requireSession(terminalId);
    if (!session.pty || session.info.status !== "running") {
      throw new Error(`Terminal ${terminalId} is no longer running.`);
    }
    return session as LocalTerminalSession & { pty: IPty };
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

async function requireDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error("Terminal cwd must be a directory.");
}
