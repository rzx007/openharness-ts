import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
  open as fsOpen,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "paused" | "closed";
  metadata: Record<string, unknown>;
}

/** UI-safe snapshot of a spawned bridge session. */
export interface BridgeSessionRecord {
  sessionId: string;
  command: string;
  cwd: string;
  pid: number;
  status: "running" | "completed" | "failed";
  startedAt: number;
  outputPath: string;
}

// ---------------------------------------------------------------------------
// Internal handle
// ---------------------------------------------------------------------------

interface SessionHandle {
  sessionId: string;
  command: string;
  cwd: string;
  process: ChildProcess;
  startedAt: number;
  outputPath: string;
  /** Resolves when stdout pump finishes. */
  pumpDone: Promise<void>;
}

async function killHandle(handle: SessionHandle): Promise<void> {
  const proc = handle.process;
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      resolve();
    }, 3000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// BridgeManager
// ---------------------------------------------------------------------------

export class BridgeManager {
  private readonly metaDir: string;
  private readonly logDir: string;
  private readonly handles = new Map<string, SessionHandle>();
  private readonly metaSessions = new Map<string, BridgeSession>();

  constructor(baseDir?: string) {
    const root = baseDir ?? join(homedir(), ".openharness");
    this.metaDir = join(root, "bridge", "sessions");
    this.logDir = join(root, "bridge", "logs");
  }

  // -------------------------------------------------------------------------
  // Process-managed spawn
  // -------------------------------------------------------------------------

  async spawn(options: {
    sessionId?: string;
    command: string;
    cwd: string;
    name?: string;
  }): Promise<BridgeSessionRecord> {
    const sessionId = options.sessionId ?? randomUUID().slice(0, 8);
    await mkdir(this.logDir, { recursive: true });
    const outputPath = join(this.logDir, `${sessionId}.log`);

    // clear/create log file
    await writeFile(outputPath, "", "utf-8");

    const proc = nodeSpawn(options.command, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pumpDone = this._pumpOutput(proc, outputPath);

    const handle: SessionHandle = {
      sessionId,
      command: options.command,
      cwd: options.cwd,
      process: proc,
      startedAt: Date.now(),
      outputPath,
      pumpDone,
    };
    this.handles.set(sessionId, handle);

    return this._toRecord(handle);
  }

  // -------------------------------------------------------------------------
  // Stop (terminate → kill)
  // -------------------------------------------------------------------------

  async stop(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) throw new Error(`Unknown bridge session: ${sessionId}`);
    await killHandle(handle);
    await handle.pumpDone.catch(() => {});
  }

  // -------------------------------------------------------------------------
  // List / read output
  // -------------------------------------------------------------------------

  listSpawnedSessions(): BridgeSessionRecord[] {
    return [...this.handles.values()]
      .map((h) => this._toRecord(h))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async readOutput(sessionId: string, maxBytes = 12_000): Promise<string> {
    const handle = this.handles.get(sessionId);
    if (!handle) return "";
    try {
      const content = await readFile(handle.outputPath, "utf-8");
      return content.length > maxBytes ? content.slice(-maxBytes) : content;
    } catch {
      return "";
    }
  }

  // -------------------------------------------------------------------------
  // Metadata sessions (persisted, no process)
  // -------------------------------------------------------------------------

  async createSession(name?: string): Promise<BridgeSession> {
    const session: BridgeSession = {
      id: randomUUID().slice(0, 8),
      name: name ?? `session-${Date.now()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "active",
      metadata: {},
    };
    this.metaSessions.set(session.id, session);
    await this._persistMeta(session);
    return session;
  }

  getSession(id: string): BridgeSession | undefined {
    return this.metaSessions.get(id);
  }

  listSessions(): BridgeSession[] {
    return [...this.metaSessions.values()];
  }

  async closeSession(id: string): Promise<void> {
    const session = this.metaSessions.get(id);
    if (session) {
      session.status = "closed";
      session.updatedAt = Date.now();
      await this._persistMeta(session);
    }
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    const session = this.metaSessions.get(id);
    if (session) {
      Object.assign(session.metadata, metadata);
      session.updatedAt = Date.now();
      await this._persistMeta(session);
    }
  }

  async loadPersistedSessions(): Promise<number> {
    try {
      const files = await readdir(this.metaDir);
      let count = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(this.metaDir, file), "utf-8");
          const session: BridgeSession = JSON.parse(raw);
          this.metaSessions.set(session.id, session);
          count++;
        } catch {}
      }
      return count;
    } catch {
      return 0;
    }
  }

  async deleteSession(id: string): Promise<void> {
    this.metaSessions.delete(id);
    try {
      await rm(join(this.metaDir, `${id}.json`));
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _toRecord(handle: SessionHandle): BridgeSessionRecord {
    const { exitCode } = handle.process;
    const status: BridgeSessionRecord["status"] =
      exitCode === null ? "running" : exitCode === 0 ? "completed" : "failed";
    return {
      sessionId: handle.sessionId,
      command: handle.command,
      cwd: handle.cwd,
      pid: handle.process.pid ?? 0,
      status,
      startedAt: handle.startedAt,
      outputPath: handle.outputPath,
    };
  }

  private async _pumpOutput(proc: ChildProcess, outputPath: string): Promise<void> {
    const fh = await fsOpen(outputPath, "a");
    const streams = [proc.stdout, proc.stderr].filter(Boolean);
    await Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream!.on("data", (chunk: Buffer) => {
              fh.write(chunk).catch(() => {});
            });
            stream!.on("end", resolve);
            stream!.on("error", resolve);
          }),
      ),
    );
    await fh.close().catch(() => {});
  }

  private async _persistMeta(session: BridgeSession): Promise<void> {
    await mkdir(this.metaDir, { recursive: true });
    await writeFile(
      join(this.metaDir, `${session.id}.json`),
      JSON.stringify(session, null, 2),
      "utf-8",
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: BridgeManager | undefined;

export function getBridgeManager(): BridgeManager {
  _manager ??= new BridgeManager();
  return _manager;
}
