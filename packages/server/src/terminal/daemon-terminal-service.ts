import { resolve } from "node:path";

import type {
  AgentTerminalHost,
  TerminalCreateRequest,
  TerminalEventListener,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalSignalRequest,
  TerminalSource,
  TerminalWriteRequest,
} from "@openharness/terminal";
import { LocalTerminalProvider } from "@openharness/terminal-node";
import type { SessionRecord, SessionStore } from "@openharness/services";

export interface ListDaemonTerminalsOptions {
  projectId?: string;
  sessionId?: string;
  source?: TerminalSource;
}

export class DaemonTerminalService {
  private readonly provider: LocalTerminalProvider;

  constructor(private readonly store: Pick<SessionStore, "getProject">) {
    this.provider = new LocalTerminalProvider({
      resolveCwd: async (input) => {
        if (input.cwd) return resolve(input.cwd);
        const project = this.store.getProject(input.projectId);
        if (!project)
          throw new DaemonTerminalError(
            404,
            `Project not found: ${input.projectId}`,
          );
        return project.path;
      },
    });
  }

  async create(input: TerminalCreateRequest): Promise<TerminalSessionInfo> {
    return await this.provider.create({
      projectId: requireValue(input.projectId, "projectId"),
      runtime: input.runtime,
      cols: input.cols,
      rows: input.rows,
      name: input.name,
      shell: input.shell,
      cwd: input.cwd,
      source: input.source ?? "user",
      sessionId: input.sessionId,
    });
  }

  async list(
    options: ListDaemonTerminalsOptions = {},
  ): Promise<TerminalSessionInfo[]> {
    return (await this.provider.list()).filter((terminal) => {
      if (options.projectId && terminal.projectId !== options.projectId)
        return false;
      if (options.sessionId && terminal.sessionId !== options.sessionId)
        return false;
      if (options.source && terminal.source !== options.source) return false;
      return true;
    });
  }

  async get(terminalId: string): Promise<TerminalSessionInfo> {
    const terminal = (await this.provider.list()).find(
      (item) => item.id === terminalId,
    );
    if (!terminal)
      throw new DaemonTerminalError(
        404,
        `Terminal ${terminalId} does not exist.`,
      );
    return terminal;
  }

  async write(input: TerminalWriteRequest): Promise<void> {
    await this.provider.write(input);
  }

  async resize(input: TerminalResizeRequest): Promise<void> {
    await this.provider.resize(input);
  }

  async read(terminalId: string): Promise<TerminalReadResult> {
    return await this.provider.read({ terminalId });
  }

  async signal(input: TerminalSignalRequest): Promise<void> {
    await this.provider.signal(input);
  }

  async close(terminalId: string): Promise<void> {
    await this.get(terminalId);
    await this.provider.kill(terminalId);
  }

  subscribe(listener: TerminalEventListener): () => void {
    return this.provider.subscribe(listener);
  }

  createAgentHost(rootSession: SessionRecord): AgentTerminalHost {
    const projectId = rootSession.projectId;
    if (!projectId) {
      throw new DaemonTerminalError(
        400,
        `Session ${rootSession.id} is not attached to a project.`,
      );
    }
    const requireOwned = async (
      sessionId: string,
      terminalId: string,
    ): Promise<void> => {
      const terminal = await this.get(terminalId);
      if (terminal.source !== "agent" || terminal.sessionId !== sessionId) {
        throw new DaemonTerminalError(
          403,
          `Terminal ${terminalId} is not owned by this Agent session.`,
        );
      }
    };

    return {
      open: async (input) =>
        await this.provider.create({
          projectId,
          runtime: "local",
          cols: input.cols ?? 100,
          rows: input.rows ?? 30,
          name: input.name ?? "Agent terminal",
          shell: input.shell,
          cwd: input.cwd,
          source: "agent",
          sessionId: input.sessionId,
        }),
      send: async (input) => {
        await requireOwned(input.sessionId, input.terminalId);
        await this.provider.write(input);
      },
      read: async (input) => {
        await requireOwned(input.sessionId, input.terminalId);
        return await this.provider.read(input);
      },
      signal: async (input) => {
        await requireOwned(input.sessionId, input.terminalId);
        await this.provider.signal(input);
      },
      close: async (input) => {
        await requireOwned(input.sessionId, input.terminalId);
        await this.provider.kill(input.terminalId);
      },
      list: async (sessionId) =>
        await this.list({ sessionId, source: "agent" }),
    };
  }

  async dispose(): Promise<void> {
    await this.provider.dispose();
  }
}

export class DaemonTerminalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonTerminalError";
  }
}

function requireValue(value: string, name: string): string {
  if (!value.trim()) throw new DaemonTerminalError(400, `${name} is required.`);
  return value.trim();
}
