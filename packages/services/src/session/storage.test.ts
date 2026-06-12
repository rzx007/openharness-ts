import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  getProjectSessionDir,
  saveSessionSnapshot,
  loadSessionSnapshot,
  listSessionSnapshots,
  loadSessionById,
  exportSessionMarkdown,
} from "./storage.js";

let cfgDir: string;
let projDir: string;

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), "ohs-ss-cfg-"));
  projDir = mkdtempSync(join(tmpdir(), "ohs-ss-proj-"));
  process.env.OPENHARNESS_CONFIG_DIR = cfgDir;
});

afterEach(() => {
  delete process.env.OPENHARNESS_CONFIG_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

const baseArgs = () => ({
  cwd: projDir,
  model: "test-model",
  systemPrompt: "sys",
  usage: { inputTokens: 10, outputTokens: 5 },
});

describe("getProjectSessionDir", () => {
  it("is <sessionsDir>/<projname>-<sha1cwd12> and stable", () => {
    const dir1 = getProjectSessionDir(projDir);
    expect(dir1).toBe(getProjectSessionDir(projDir));
    expect(basename(dir1)).toMatch(new RegExp(`^${basename(projDir)}-[0-9a-f]{12}$`));
    expect(existsSync(dir1)).toBe(true);
  });
});

describe("saveSessionSnapshot", () => {
  it("dual-writes latest.json and session-<id>.json with summary and metadata whitelist", () => {
    const path = saveSessionSnapshot({
      ...baseArgs(),
      sessionId: "s1",
      messages: [
        { type: "system", content: "sys" },
        { type: "user", content: "fix the login bug in auth.ts please" },
      ],
      toolMetadata: {
        permission_mode: "default",
        task_focus_state: { goal: "g" },
        session_memory_path: "/should/be/dropped", // 不在白名单
        secret_thing: "drop me too",
      },
    });
    const dir = getProjectSessionDir(projDir);
    expect(path).toBe(join(dir, "latest.json"));
    expect(existsSync(join(dir, "session-s1.json"))).toBe(true);

    const payload = JSON.parse(readFileSync(path, "utf-8"));
    expect(payload.session_id).toBe("s1");
    expect(payload.summary).toBe("fix the login bug in auth.ts please");
    expect(payload.message_count).toBe(2);
    expect(payload.model).toBe("test-model");
    expect(payload.tool_metadata).toEqual({
      permission_mode: "default",
      task_focus_state: { goal: "g" },
    });
    // 双写内容一致
    expect(readFileSync(join(dir, "session-s1.json"), "utf-8")).toBe(readFileSync(path, "utf-8"));
  });

  it("generates a session id when omitted and sanitizes non-JSON metadata values", () => {
    const path = saveSessionSnapshot({
      ...baseArgs(),
      messages: [{ type: "user", content: "hi" }],
      toolMetadata: { permission_mode: new Set(["x"]) as unknown as string },
    });
    const payload = JSON.parse(readFileSync(path, "utf-8"));
    expect(payload.session_id).toMatch(/^[0-9a-f]{12}$/);
    // Set → 数组(可 JSON 化)
    expect(payload.tool_metadata.permission_mode).toEqual(["x"]);
  });
});

describe("load / list / loadById", () => {
  it("loadSessionSnapshot reads latest; null when missing", () => {
    expect(loadSessionSnapshot(projDir)).toBeNull();
    saveSessionSnapshot({ ...baseArgs(), sessionId: "a", messages: [{ type: "user", content: "m" }] });
    expect(loadSessionSnapshot(projDir)!.session_id).toBe("a");
  });

  it("listSessionSnapshots returns newest-first with dedup against latest", () => {
    saveSessionSnapshot({ ...baseArgs(), sessionId: "one", messages: [{ type: "user", content: "first session" }] });
    saveSessionSnapshot({ ...baseArgs(), sessionId: "two", messages: [{ type: "user", content: "second session" }] });
    const list = listSessionSnapshots(projDir);
    expect(list.map((s) => s.session_id)).toEqual(["two", "one"]);
    expect(list[0]!.summary).toBe("second session");
    expect(listSessionSnapshots(projDir, 1)).toHaveLength(1);
  });

  it("loadSessionById: named file, latest fallback, miss → null", () => {
    saveSessionSnapshot({ ...baseArgs(), sessionId: "x1", messages: [{ type: "user", content: "m" }] });
    expect(loadSessionById(projDir, "x1")!.session_id).toBe("x1");
    expect(loadSessionById(projDir, "latest")!.session_id).toBe("x1");
    expect(loadSessionById(projDir, "nope")).toBeNull();
  });
});

describe("exportSessionMarkdown", () => {
  it("writes transcript.md with role sections and tool fences", () => {
    const path = exportSessionMarkdown({
      cwd: projDir,
      messages: [
        { type: "user", content: "do the thing" },
        {
          type: "assistant",
          content: [
            { type: "text", text: "on it" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
        { type: "tool_result", content: [{ type: "tool_result", content: "file1\nfile2" }] },
      ],
    });
    const md = readFileSync(path, "utf-8");
    expect(md).toContain("# OpenHarness Session Transcript");
    expect(md).toContain("## User");
    expect(md).toContain("do the thing");
    expect(md).toContain("```tool");
    expect(md).toContain('Bash {"command":"ls"}');
    expect(md).toContain("```tool-result");
    expect(md).toContain("file1");
  });
});
