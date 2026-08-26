import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadNativeAgents, validateNativePlugin } from "@openharness/plugins";
import { ClaudeCodePluginConverter } from "./converter.js";
const source = fileURLToPath(
  new URL("../../fixtures/claude-code/mixed-plugin", import.meta.url),
);
const outputs: string[] = [];
afterEach(async () => {
  await Promise.all(
    outputs.splice(0).map((x) => rm(x, { recursive: true, force: true })),
  );
});
describe("ClaudeCodePluginConverter", () => {
  it("detects, inspects, plans and materializes a valid Native Plugin", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ohs-convert-"));
    outputs.push(parent);
    const output = join(parent, "native");
    const converter = new ClaudeCodePluginConverter();
    expect(await converter.detect(source)).not.toBeNull();
    const inspection = await converter.inspect(source);
    const plan = await converter.plan(inspection);
    const report = await converter.convert({
      inspection,
      plan,
      output,
      approvals: [],
    });
    expect(report.status).toBe("success");
    expect((await validateNativePlugin(output)).status).toBe("valid");
  });

  it("does not mark unsupported-only hook files as adapted", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohs-convert-hooks-"));
    outputs.push(root);
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "hooks"), { recursive: true });
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "unsupported-hooks", version: "1.0.0" }),
    );
    await writeFile(
      join(root, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
      }),
    );
    const converter = new ClaudeCodePluginConverter();
    const plan = await converter.plan(await converter.inspect(root));
    expect(plan.items).toEqual([
      expect.objectContaining({
        id: "hooks:event:Stop",
        fidelity: "unsupported",
      }),
    ]);
  });

  it("quotes Claude agent descriptions that contain YAML mapping syntax", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ohs-convert-agent-description-"),
    );
    outputs.push(root);
    const output = join(root, "native");
    const sourceRoot = join(root, "source");
    await mkdir(join(sourceRoot, ".claude-plugin"), { recursive: true });
    await mkdir(join(sourceRoot, "agents"), { recursive: true });
    await writeFile(
      join(sourceRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ui-designer", version: "1.0.0" }),
    );
    await writeFile(
      join(sourceRoot, "agents", "ui-designer.md"),
      [
        "---",
        "name: ui-designer",
        String.raw`description: Design interfaces. Examples:\n\nContext: Starting a new feature`,
        String.raw`user: "Create a settings page"\nassistant: "I will design it"`,
        String.raw`commentary: Keep the hierarchy clear.\n</example>`,
        "color: magenta",
        "tools: Write, Read",
        "---",
        "Design useful interfaces.",
      ].join("\n"),
    );

    const converter = new ClaudeCodePluginConverter();
    const inspection = await converter.inspect(sourceRoot);
    await converter.convert({
      inspection,
      plan: await converter.plan(inspection),
      output,
    });
    const validation = await validateNativePlugin(output);
    expect(validation.status).toBe("valid");

    const loaded = await loadNativeAgents(validation.plugin!);
    expect(loaded.status).toBe("loaded");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.value[0]?.description).toContain(
      "Context: Starting a new feature",
    );
    expect(loaded.value[0]?.description).toContain("Create a settings page");
    expect(loaded.value[0]?.tools).toEqual(["Write", "Read"]);
  });
});
