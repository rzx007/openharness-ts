import { beforeAll, describe, expect, it } from "vitest";
import {
  createShellProcess,
  detectSandboxPlatform,
  getSrtAvailability,
  startSandboxRuntime,
} from "../src/index.js";
import { baseSettings, collectProcess } from "./helpers.js";

const availability = getSrtAvailability({
  enabled: true,
  backend: "srt",
  failIfUnavailable: true,
});
const maybeDescribe = availability.available ? describe : describe.skip;

beforeAll(() => {
  if (!availability.available) {
    console.warn(`[sandbox:e2e:srt] skipped: ${availability.reason ?? "srt is unavailable"}`);
  }
});

maybeDescribe("srt sandbox e2e", () => {
  it("reports active runtime and executes a shell command through srt", async () => {
    const settings = {
      ...baseSettings,
      sandbox: {
        enabled: true,
        backend: "srt",
        failIfUnavailable: true,
        filesystem: { allowRead: ["."], allowWrite: ["."] },
      },
    } as const;

    const runtime = await startSandboxRuntime({
      settings,
      cwd: process.cwd(),
      sessionId: `e2e-srt-${Date.now()}`,
    });

    expect(runtime.status).toMatchObject({
      state: "active",
      active: true,
      backend: "srt",
      platform: detectSandboxPlatform(),
    });

    const child = await createShellProcess("echo srt-ok", {
      cwd: process.cwd(),
      settings,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await collectProcess(child);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("srt-ok");
  }, 60_000);
});
