import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Settings } from "@openharness/core";
import type { TaskInfo } from "../tasks/index.js";
import {
  readLastConsolidatedAt,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
  listSessionsTouchedSince,
  createMemoryBackup,
  diffMemoryDirs,
  formatMemoryDiff,
  restoreMemoryBackup,
  buildConsolidationPrompt,
  startDreamNow,
  _resetAutodreamStateForTests,
  LOCK_FILE,
  type DreamTaskRunner,
} from "./index.js";

let tmp: string;
let memoryDir: string;
let sessionDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ohs-dream-"));
  memoryDir = join(tmp, "memory");
  sessionDir = join(tmp, "sessions");
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  process.env.OPENHARNESS_CONFIG_DIR = join(tmp, "cfg");
  delete process.env.OPENHARNESS_AUTODREAM_CHILD;
  _resetAutodreamStateForTests();
});

afterEach(() => {
  delete process.env.OPENHARNESS_CONFIG_DIR;
  delete process.env.OPENHARNESS_AUTODREAM_CHILD;
  rmSync(tmp, { recursive: true, force: true });
});

function settings(memory?: Settings["memory"]): Settings {
  return {
    model: "m",
    apiFormat: "anthropic",
    maxTurns: 50,
    permission: { mode: "default" },
    memory,
  } as Settings;
}

function fakeRunner(): DreamTaskRunner & { tasks: TaskInfo[]; fire: (task: TaskInfo, event: string) => void } {
  const listeners: Array<(task: TaskInfo, event: string) => void> = [];
  const tasks: TaskInfo[] = [];
  return {
    tasks,
    async createShellTask(options) {
      const task = {
        id: `task_${tasks.length + 1}`,
        type: "dream",
        status: "running",
        description: options.description,
        cwd: options.cwd,
        argv: options.argv,
        env: options.env,
        createdAt: Date.now(),
        metadata: {},
      } as unknown as TaskInfo;
      tasks.push(task);
      return task;
    },
    registerTaskListener(listener) {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    fire(task, event) {
      for (const l of [...listeners]) l(task, event);
    },
  };
}

describe("consolidation lock", () => {
  it("acquire returns prior mtime, blocks while held by a live process, rollback restores", () => {
    expect(readLastConsolidatedAt(memoryDir)).toBe(0);
    const prior = tryAcquireConsolidationLock(memoryDir);
    expect(prior).toBe(0);
    // 自己持有（PID 是本进程且 1h 内）→ Python 语义:同进程视为 running → 占用。
    expect(tryAcquireConsolidationLock(memoryDir)).toBeNull();

    // 回滚到 0 → 锁文件删除。
    rollbackConsolidationLock(memoryDir, 0);
    expect(existsSync(join(memoryDir, LOCK_FILE))).toBe(false);

    // 回滚到具体时间 → mtime 还原。
    const t = tryAcquireConsolidationLock(memoryDir);
    expect(t).toBe(0);
    rollbackConsolidationLock(memoryDir, 1700000000);
    expect(Math.round(readLastConsolidatedAt(memoryDir))).toBe(1700000000);
  });

  it("steals a stale lock from a dead holder", () => {
    const lockPath = join(memoryDir, LOCK_FILE);
    writeFileSync(lockPath, "999999\n"); // 几乎必然不存在的 PID
    const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000; // 2h 前 → 超过 stale 阈值
    utimesSync(lockPath, past, past);
    expect(tryAcquireConsolidationLock(memoryDir)).not.toBeNull();
  });
});

describe("listSessionsTouchedSince", () => {
  it("returns ids newer than since, dedup, excludes current, prefers payload id", () => {
    writeFileSync(join(sessionDir, "session-old.json"), JSON.stringify({ id: "old" }));
    const past = (Date.now() - 10000_000) / 1000;
    utimesSync(join(sessionDir, "session-old.json"), past, past);
    writeFileSync(join(sessionDir, "abc.json"), JSON.stringify({ session_id: "abc-real" }));
    writeFileSync(join(sessionDir, "cur.json"), JSON.stringify({ id: "current" }));
    writeFileSync(join(sessionDir, "broken.json"), "not json");

    const ids = listSessionsTouchedSince(sessionDir, Date.now() / 1000 - 3600, "current");
    expect(ids).toContain("abc-real");
    expect(ids).toContain("broken");
    expect(ids).not.toContain("current");
    expect(ids).not.toContain("old");
  });
});

describe("backup / diff / restore", () => {
  it("backs up md files (skipping the lock), diffs content, restores", () => {
    writeFileSync(join(memoryDir, "a.md"), "A1");
    writeFileSync(join(memoryDir, "b.md"), "B");
    writeFileSync(join(memoryDir, LOCK_FILE), "123");

    const backup = createMemoryBackup(memoryDir);
    expect(existsSync(join(backup, "a.md"))).toBe(true);
    expect(existsSync(join(backup, LOCK_FILE))).toBe(false);

    writeFileSync(join(memoryDir, "a.md"), "A2"); // changed
    rmSync(join(memoryDir, "b.md")); // removed
    writeFileSync(join(memoryDir, "c.md"), "C"); // added

    const diff = diffMemoryDirs(backup, memoryDir);
    expect(diff).toEqual({ added: ["c.md"], removed: ["b.md"], changed: ["a.md"] });
    expect(formatMemoryDiff(diff)).toContain("added: c.md");
    expect(formatMemoryDiff({ added: [], removed: [], changed: [] })).toBe("no markdown file changes");

    restoreMemoryBackup(backup, memoryDir);
    expect(readFileSync(join(memoryDir, "a.md"), "utf-8")).toBe("A1");
    expect(existsSync(join(memoryDir, "b.md"))).toBe(true);
    expect(existsSync(join(memoryDir, "c.md"))).toBe(false);
  });
});

describe("buildConsolidationPrompt", () => {
  it("contains the policy sections, mode switch, and extra context", () => {
    const apply = buildConsolidationPrompt("/mem", "/sess", "extra stuff");
    expect(apply).toContain("# Dream: Memory Consolidation");
    expect(apply).toContain("APPLY MODE");
    expect(apply).toContain("Never preserve API keys");
    expect(apply).toContain("## Additional context\n\nextra stuff");
    expect(buildConsolidationPrompt("/mem", "/sess", "", { preview: true })).toContain("PREVIEW MODE");
  });
});

describe("startDreamNow", () => {
  const mem = { enabled: true, autoDreamEnabled: true };

  it("force-starts a dream: lock acquired, backup made, argv carries the prompt", async () => {
    writeFileSync(join(memoryDir, "a.md"), "A");
    const runner = fakeRunner();
    const task = await startDreamNow({
      cwd: tmp,
      settings: settings(mem),
      memoryDir,
      sessionDir,
      force: true,
      taskRunner: runner,
      cliEntry: "/cli.js",
      staleSection: "- old-memory.md",
    });
    expect(task).not.toBeNull();
    expect(task!.env?.OPENHARNESS_AUTODREAM_CHILD).toBe("1");
    const argv = task!.argv!;
    expect(argv).toContain("--print");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv.join(" ")).toContain("Dream: Memory Consolidation");
    expect(argv.join(" ")).toContain("- old-memory.md");
    expect(task!.metadata.backup_dir).not.toBe("");
    // 锁已被持有：再次启动被拒。
    expect(
      await startDreamNow({ cwd: tmp, settings: settings(mem), memoryDir, sessionDir, force: true, taskRunner: runner, cliEntry: "/cli.js" }),
    ).toBeNull();
  });

  it("refuses inside a dream child process and when memory is disabled", async () => {
    const runner = fakeRunner();
    process.env.OPENHARNESS_AUTODREAM_CHILD = "1";
    expect(
      await startDreamNow({ cwd: tmp, settings: settings(mem), memoryDir, sessionDir, force: true, taskRunner: runner }),
    ).toBeNull();
    delete process.env.OPENHARNESS_AUTODREAM_CHILD;
    expect(
      await startDreamNow({ cwd: tmp, settings: settings({ enabled: false }), memoryDir, sessionDir, force: true, taskRunner: runner }),
    ).toBeNull();
  });

  it("rolls back the lock when the dream task fails", async () => {
    const runner = fakeRunner();
    const task = (await startDreamNow({
      cwd: tmp,
      settings: settings(mem),
      memoryDir,
      sessionDir,
      force: true,
      taskRunner: runner,
      cliEntry: "/cli.js",
    }))!;
    (task as { status: string }).status = "failed";
    runner.fire(task, "completed");
    // 锁回滚到 0 → 文件删除 → 可再次获取。
    expect(existsSync(join(memoryDir, LOCK_FILE))).toBe(false);
  });
});
