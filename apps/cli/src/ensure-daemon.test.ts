import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonRegistry } from "@openharness/server";

const statMock = vi.hoisted(() => vi.fn());
const readDaemonRegistryMock = vi.hoisted(() => vi.fn());
const clearDaemonRegistryMock = vi.hoisted(() => vi.fn());
const probeDaemonRegistryMock = vi.hoisted(() => vi.fn());
const terminateDaemonProcessMock = vi.hoisted(() => vi.fn());
const spawnDaemonProcessMock = vi.hoisted(() => vi.fn());
const daemonStartupErrorMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  stat: statMock,
}));

vi.mock("@openharness/server", () => ({
  readDaemonRegistry: readDaemonRegistryMock,
  clearDaemonRegistry: clearDaemonRegistryMock,
}));

vi.mock("./daemon-lifecycle.js", () => ({
  probeDaemonRegistry: probeDaemonRegistryMock,
  terminateDaemonProcess: terminateDaemonProcessMock,
}));

vi.mock("./daemon-process.js", () => ({
  spawnDaemonProcess: spawnDaemonProcessMock,
  daemonStartupError: daemonStartupErrorMock,
}));

import { ensureLocalDaemon } from "./ensure-daemon.js";

function registry(overrides: Partial<DaemonRegistry> = {}): DaemonRegistry {
  return {
    url: "http://127.0.0.1:1234",
    pid: 123,
    token: "token",
    storePath: "sessions.db",
    startedAt: 200,
    version: "0.1.0",
    ...overrides,
  };
}

function spawned(failure?: string) {
  return {
    child: { pid: 456 },
    logPath: "D:/logs/daemon.log",
    failure: vi.fn(() => failure),
  };
}

describe("ensureLocalDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statMock.mockResolvedValue({ mtimeMs: 100 });
    spawnDaemonProcessMock.mockReturnValue(spawned());
    daemonStartupErrorMock.mockReturnValue(new Error("daemon startup failed"));
    terminateDaemonProcessMock.mockReturnValue(true);
  });

  it("returns an already-ready daemon without spawning", async () => {
    const ready = registry({ version: "0.2.0" });
    readDaemonRegistryMock.mockReturnValue(ready);
    probeDaemonRegistryMock.mockResolvedValue("ready");

    const handle = await ensureLocalDaemon({
      cliPath: "D:/repo/apps/cli/dist/index.js",
      expectedVersion: "0.2.0",
    });

    expect(handle).toEqual({
      url: ready.url,
      token: ready.token,
      pid: ready.pid,
      storePath: ready.storePath,
      version: ready.version,
    });
    expect(probeDaemonRegistryMock).toHaveBeenCalledWith(ready, {
      expectedVersion: "0.2.0",
      minimumStartedAt: 100,
    });
    expect(clearDaemonRegistryMock).not.toHaveBeenCalled();
    expect(spawnDaemonProcessMock).not.toHaveBeenCalled();
    expect(terminateDaemonProcessMock).not.toHaveBeenCalled();
  });

  it("spawns serve and waits for registry when no daemon is registered", async () => {
    const ready = registry({ pid: 456, url: "http://127.0.0.1:5678" });
    readDaemonRegistryMock
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(ready);
    probeDaemonRegistryMock.mockResolvedValue("ready");

    const handle = await ensureLocalDaemon({ cliPath: "cli-entry.js", expectedVersion: "0.1.0" });

    expect(clearDaemonRegistryMock).toHaveBeenCalledOnce();
    expect(spawnDaemonProcessMock).toHaveBeenCalledWith("cli-entry.js", [
      "serve",
      "--register",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    expect(handle).toMatchObject({ url: ready.url, token: ready.token, pid: ready.pid });
    expect(terminateDaemonProcessMock).not.toHaveBeenCalled();
  });

  it("terminates a stale registered daemon before spawning a fresh one", async () => {
    const stale = registry({ pid: 111, startedAt: 50 });
    const ready = registry({ pid: 222, startedAt: 300 });
    readDaemonRegistryMock
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(ready);
    probeDaemonRegistryMock
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("ready");

    const handle = await ensureLocalDaemon({ cliPath: "cli-entry.js", expectedVersion: "0.1.0" });

    expect(terminateDaemonProcessMock).toHaveBeenCalledWith(stale.pid);
    expect(clearDaemonRegistryMock).toHaveBeenCalledOnce();
    expect(spawnDaemonProcessMock).toHaveBeenCalledOnce();
    expect(handle.pid).toBe(ready.pid);
  });

  it("clears an unreachable registered daemon without terminating it", async () => {
    const unreachable = registry({ pid: 333 });
    const ready = registry({ pid: 444 });
    readDaemonRegistryMock
      .mockReturnValueOnce(unreachable)
      .mockReturnValueOnce(ready);
    probeDaemonRegistryMock
      .mockResolvedValueOnce("unreachable")
      .mockResolvedValueOnce("ready");

    const handle = await ensureLocalDaemon({ cliPath: "cli-entry.js", expectedVersion: "0.1.0" });

    expect(terminateDaemonProcessMock).not.toHaveBeenCalled();
    expect(clearDaemonRegistryMock).toHaveBeenCalledOnce();
    expect(spawnDaemonProcessMock).toHaveBeenCalledOnce();
    expect(handle.pid).toBe(ready.pid);
  });

  it("reports a child process failure instead of waiting for the registry timeout", async () => {
    const failed = spawned("exited with code 1");
    readDaemonRegistryMock.mockReturnValue(null);
    spawnDaemonProcessMock.mockReturnValue(failed);

    await expect(ensureLocalDaemon({
      cliPath: "cli-entry.js",
      expectedVersion: "0.1.0",
    })).rejects.toThrow("daemon startup failed");

    expect(daemonStartupErrorMock).toHaveBeenCalledWith(failed);
  });
});
