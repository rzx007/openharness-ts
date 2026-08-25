import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateNativePlugin } from "@openharness/plugins";
import { ClaudeCodePluginConverter } from "./converter.js";
const source = fileURLToPath(new URL("../../fixtures/claude-code/mixed-plugin", import.meta.url));
const outputs: string[] = [];
afterEach(async () => { await Promise.all(outputs.splice(0).map((x) => rm(x, { recursive: true, force: true }))); });
describe("ClaudeCodePluginConverter", () => {
  it("detects, inspects, plans and materializes a valid Native Plugin", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ohs-convert-")); outputs.push(parent); const output = join(parent, "native");
    const converter = new ClaudeCodePluginConverter(); expect(await converter.detect(source)).not.toBeNull();
    const inspection = await converter.inspect(source); const plan = await converter.plan(inspection);
    const report = await converter.convert({ inspection, plan, output, approvals: [] });
    expect(report.status).toBe("success"); expect((await validateNativePlugin(output)).status).toBe("valid");
  });
});
