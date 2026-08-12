import { beforeEach, describe, expect, it, vi } from "vitest";

const loadSettingsMock = vi.hoisted(() => vi.fn());
const saveSettingsMock = vi.hoisted(() => vi.fn());
const serviceMock = vi.hoisted(() => ({
  status: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@openharness/core", () => ({
  loadSettings: loadSettingsMock,
  saveSettings: saveSettingsMock,
}));

vi.mock("./daemon-system-service.js", () => ({
  createDaemonSystemService: vi.fn(() => serviceMock),
}));

import {
  loadDaemonAutoStart,
  reconcileDaemonAutoStart,
  saveDaemonAutoStart,
} from "./daemon-auto-start.js";

describe("daemon auto-start settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSettingsMock.mockResolvedValue({ model: "m", daemon: { autoStart: false } });
    serviceMock.status.mockReturnValue({ platform: "win32", state: "not-installed" });
  });

  it("loads and saves daemon.autoStart without dropping other settings", async () => {
    expect(await loadDaemonAutoStart()).toBe(false);

    await saveDaemonAutoStart(true);

    expect(saveSettingsMock).toHaveBeenCalledWith({ model: "m", daemon: { autoStart: true } });
  });

  it("installs the system service when automatic startup is enabled", () => {
    const result = reconcileDaemonAutoStart("cli.js", true);

    expect(serviceMock.install).toHaveBeenCalledOnce();
    expect(result.action).toBe("installed");
    expect(result.state).toBe("running");
  });

  it("starts a disabled system service when automatic startup is enabled", () => {
    serviceMock.status.mockReturnValue({ platform: "win32", state: "stopped" });

    const result = reconcileDaemonAutoStart("cli.js", true);

    expect(serviceMock.start).toHaveBeenCalledOnce();
    expect(result.action).toBe("started");
  });

  it("uninstalls the system service when automatic startup is disabled", () => {
    serviceMock.status.mockReturnValue({ platform: "win32", state: "running" });

    const result = reconcileDaemonAutoStart("cli.js", false);

    expect(serviceMock.uninstall).toHaveBeenCalledOnce();
    expect(result.action).toBe("uninstalled");
    expect(result.state).toBe("not-installed");
  });
});
