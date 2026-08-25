import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverInstalledNativePlugins,
  installLocalNativePlugin,
  loadNativePlugin,
  validateNativePlugin,
} from "@openharness/plugins";
import { ClaudeCodePluginConverter } from "./claude-code/converter.js";

const source = fileURLToPath(new URL("../fixtures/claude-code/mixed-plugin", import.meta.url));
const cleanup: string[] = [];
const previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
  else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Native Plugin acceptance", () => {
  it("converts, validates, installs, discovers and loads a Claude source without executing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohs-plugin-acceptance-")); cleanup.push(root);
    process.env.OPENHARNESS_CONFIG_DIR = join(root, "config");
    const converter = new ClaudeCodePluginConverter();
    const inspection = await converter.inspect(source);
    const plan = await converter.plan(inspection);
    const output = join(root, "converted");
    expect((await converter.convert({ inspection, plan, output, approvals: [] })).status).toBe("success");
    const validation = await validateNativePlugin(output);
    expect(validation.status).toBe("valid");
    const installed = await installLocalNativePlugin({ sourcePath: output, scope: "project", cwd: root, approvedPermissions: [] });
    expect(installed.status).toBe("installed");
    if (installed.status === "installed") expect(installed.record.origin).toBe("converted");
    expect(await discoverInstalledNativePlugins({ cwd: root })).toHaveLength(1);
    const loaded = await loadNativePlugin(validation.plugin!);
    expect(loaded.status).toBe("loaded");
    expect(loaded.components.skills?.value?.length).toBeGreaterThan(0);
    expect(loaded.components.agents?.value?.length).toBeGreaterThan(0);
  });
});
