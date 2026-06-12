import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Settings } from "@openharness/core";
import { getTaskManager, type TaskInfo } from "../tasks/index.js";
import {
  listSessionsTouchedSince,
  readLastConsolidatedAt,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from "./lock.js";
import { createMemoryBackup, diffMemoryDirs } from "./backup.js";
import { buildConsolidationPrompt } from "./prompt.js";

export {
  LOCK_FILE,
  HOLDER_STALE_SECONDS,
  readLastConsolidatedAt,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
  recordConsolidation,
  listSessionsTouchedSince,
} from "./lock.js";
export {
  defaultBackupRoot,
  createMemoryBackup,
  diffMemoryDirs,
  formatMemoryDiff,
  latestMemoryBackup,
  restoreMemoryBackup,
} from "./backup.js";
export { buildConsolidationPrompt, MAX_ENTRYPOINT_LINES, ENTRYPOINT_NAME } from "./prompt.js";

/**
 * Auto-dream 服务（移植自 Python autodream/service.py）。
 *
 * dream = 拉一个 `ohs --print <整合 prompt>` 子进程（type:"dream"），让模型
 * 反思性地重组 memory 目录。跑前整目录备份 + 抢整合锁；失败/被杀回滚锁 mtime。
 *
 * 与 Python 差异：① argv 不带 api-key（TS teammate 同约定，key 走 settings/env）；
 * ② stale 候选由调用方经 staleSection 传入（TS MemoryManager.findStaleCandidates
 *   是实例方法，服务层不持有实例）；③ runner 只有 openharness 形态（无 ohmo）。
 */

const CHILD_ENV = "OPENHARNESS_AUTODREAM_CHILD";
const SESSION_SCAN_INTERVAL_SECONDS = 10 * 60;
const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_SESSIONS = 3;

const lastSessionScanAt = new Map<string, number>();

/** 最小任务执行面（真实现为 getTaskManager()；测试注入 fake）。 */
export interface DreamTaskRunner {
  createShellTask(options: {
    argv: string[];
    description: string;
    cwd: string;
    env?: Record<string, string>;
    type?: string;
  }): Promise<TaskInfo>;
  registerTaskListener(listener: (task: TaskInfo, event: string) => void): () => void;
}

export interface StartDreamOptions {
  cwd: string;
  settings: Settings;
  memoryDir: string;
  sessionDir: string;
  model?: string;
  currentSessionId?: string;
  force?: boolean;
  preview?: boolean;
  appLabel?: string;
  /** 用量型 stale 候选清单（一行一条），进整合 prompt 的附加上下文。 */
  staleSection?: string;
  taskRunner?: DreamTaskRunner;
  /** CLI 入口（缺省 process.argv[1]，与 teammate 同写法）。 */
  cliEntry?: string;
}

function memoryFilesMtimeSnapshot(memoryDir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  try {
    for (const name of readdirSync(memoryDir)) {
      if (!name.endsWith(".md")) continue;
      try {
        snapshot.set(name, statSync(join(memoryDir, name)).mtimeMs);
      } catch {
        continue;
      }
    }
  } catch {
    // 目录不存在按空集
  }
  return snapshot;
}

function filesChangedSince(memoryDir: string, before: Map<string, number>): string[] {
  const changed: string[] = [];
  try {
    for (const name of readdirSync(memoryDir).sort()) {
      if (!name.endsWith(".md")) continue;
      try {
        if (before.get(name) !== statSync(join(memoryDir, name)).mtimeMs) changed.push(name);
      } catch {
        continue;
      }
    }
  } catch {
    // 目录不存在按无变化
  }
  return changed;
}

/** 立即起一次 dream（force 可跳过时间/会话数门槛）。被占/被禁/子进程内返回 null。 */
export async function startDreamNow(options: StartDreamOptions): Promise<TaskInfo | null> {
  if (process.env[CHILD_ENV]) return null;
  if (!options.settings.memory?.enabled) return null;

  const cwd = resolve(options.cwd);
  const memoryDir = resolve(options.memoryDir);
  const sessionDir = resolve(options.sessionDir);
  const memCfg = options.settings.memory;

  const lastAt = readLastConsolidatedAt(memoryDir);
  const sessionIds = listSessionsTouchedSince(sessionDir, lastAt, options.currentSessionId);
  if (!options.force) {
    const hoursSince = (Date.now() / 1000 - lastAt) / 3600;
    if (hoursSince < (memCfg.autoDreamMinHours ?? DEFAULT_MIN_HOURS)) return null;
    if (sessionIds.length < (memCfg.autoDreamMinSessions ?? DEFAULT_MIN_SESSIONS)) return null;
    if (sessionIds.length === 0) return null;
  }

  const priorMtime = tryAcquireConsolidationLock(memoryDir);
  if (priorMtime === null) return null;

  const runner = options.taskRunner ?? (getTaskManager() as unknown as DreamTaskRunner);
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const before = memoryFilesMtimeSnapshot(memoryDir);
  const backupDir = options.preview
    ? null
    : createMemoryBackup(memoryDir, { appLabel: options.appLabel });

  const extra =
    `Application context: \`${options.appLabel ?? "openharness"}\`.\n` +
    "Tool constraints for this run: only modify files under the memory directory. " +
    "Use shell commands only for read-only inspection.\n\n" +
    `Sessions since last consolidation (${sessionIds.length}):\n` +
    sessionIds.map((id) => `- ${id}`).join("\n") +
    "\n\nUsage-based stale candidates:\n" +
    (options.staleSection?.trim() || "- (none)");
  const prompt = buildConsolidationPrompt(memoryDir, sessionDir, extra, { preview: options.preview });

  const env: Record<string, string> = {
    [CHILD_ENV]: "1",
    OPENHARNESS_AUTODREAM_MEMORY_DIR: memoryDir,
  };
  const settings = options.settings;
  const cliEntry = options.cliEntry ?? process.argv[1] ?? "";
  const argv = [process.execPath, cliEntry, "--print", prompt, "--dangerously-skip-permissions"];
  if (options.model ?? settings.model) argv.push("--model", options.model ?? settings.model);
  if (settings.provider) argv.push("--provider", settings.provider);
  if (settings.baseUrl) argv.push("--base-url", settings.baseUrl);
  if (settings.apiFormat) argv.push("--api-format", settings.apiFormat);

  let task: TaskInfo;
  try {
    task = await runner.createShellTask({
      argv,
      description: "dreaming",
      cwd,
      env,
      type: "dream",
    });
  } catch (err) {
    rollbackConsolidationLock(memoryDir, priorMtime);
    throw err;
  }

  task.metadata = {
    ...task.metadata,
    phase: "starting",
    sessions_reviewing: String(sessionIds.length),
    prior_mtime: String(priorMtime),
    memory_dir: memoryDir,
    session_dir: sessionDir,
    force: String(options.force ?? false),
    preview: String(options.preview ?? false),
    backup_dir: backupDir ?? "",
  };

  // 完成监听：失败/被杀回滚锁；成功记 diff 与触碰文件。
  const unregister = runner.registerTaskListener((done, event) => {
    if (done.id !== task.id || event !== "completed") return;
    unregister();
    const status = done.status as string;
    // TS TaskStatus 的终态命名与 Python 不同（stopped≈killed，无 failed 字面量，
    // 失败以 exitCode 非 0 体现）——两套都判。
    if (status === "failed" || status === "killed" || status === "stopped" || (done.exitCode ?? 0) !== 0 || options.preview) {
      rollbackConsolidationLock(memoryDir, priorMtime);
      return;
    }
    const changed = filesChangedSince(memoryDir, before);
    if (backupDir) {
      const diff = diffMemoryDirs(backupDir, memoryDir);
      done.metadata = {
        ...done.metadata,
        files_added: diff.added.join("\n"),
        files_changed: diff.changed.join("\n"),
        files_removed: diff.removed.join("\n"),
      };
    }
    if (changed.length > 0) {
      done.metadata = { ...done.metadata, phase: "updating", files_touched: changed.join("\n") };
    }
  });

  return task;
}

/** 廉价门槛检查后后台起 dream（10 分钟内同目录只扫一次会话）。 */
export async function executeAutoDream(options: StartDreamOptions): Promise<TaskInfo | null> {
  if (process.env[CHILD_ENV]) return null;
  const memCfg = options.settings.memory;
  if (!memCfg?.enabled || !memCfg.autoDreamEnabled) return null;

  const memoryDir = resolve(options.memoryDir);
  const lastAt = readLastConsolidatedAt(memoryDir);
  if ((Date.now() / 1000 - lastAt) / 3600 < (memCfg.autoDreamMinHours ?? DEFAULT_MIN_HOURS)) return null;

  const now = Date.now() / 1000;
  if (now - (lastSessionScanAt.get(memoryDir) ?? 0) < SESSION_SCAN_INTERVAL_SECONDS) return null;
  lastSessionScanAt.set(memoryDir, now);

  const sessionIds = listSessionsTouchedSince(resolve(options.sessionDir), lastAt, options.currentSessionId);
  if (sessionIds.length < (memCfg.autoDreamMinSessions ?? DEFAULT_MIN_SESSIONS)) return null;

  return startDreamNow({ ...options, force: false });
}

/** 测试隔离：清空会话扫描节流表。 */
export function _resetAutodreamStateForTests(): void {
  lastSessionScanAt.clear();
}
