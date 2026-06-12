import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";

/**
 * autodream 整合锁与会话扫描（移植自 Python autodream/lock.py）。
 *
 * 锁文件 `.consolidate-lock` 放在 memory 目录内，内容是持有者 PID：
 * - mtime 即「上次整合时间」（成功后留下的戳）；
 * - 1 小时内且持有者进程仍活着 → 视为占用；
 * - 失败/被杀的 dream 经 rollback 把 mtime 拨回原值（不影响下次触发节奏）。
 */

export const LOCK_FILE = ".consolidate-lock";
export const HOLDER_STALE_SECONDS = 60 * 60;

const lockPath = (memoryDir: string): string => join(memoryDir, LOCK_FILE);

/** 锁文件 mtime = 上次成功整合时间；不存在返回 0。 */
export function readLastConsolidatedAt(memoryDir: string): number {
  try {
    return statSync(lockPath(memoryDir)).mtimeMs / 1000;
  } catch {
    return 0;
  }
}

function holderPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

/** 抢整合锁：成功返回先前 mtime（秒，0 表示首次），被占返回 null。 */
export function tryAcquireConsolidationLock(memoryDir: string): number | null {
  const path = lockPath(memoryDir);
  let priorMtime: number | null = null;
  let holder: number | null = null;
  try {
    priorMtime = statSync(path).mtimeMs / 1000;
    holder = holderPid(path);
  } catch {
    holder = null;
  }

  if (priorMtime !== null && Date.now() / 1000 - priorMtime < HOLDER_STALE_SECONDS) {
    if (holder !== null && isProcessRunning(holder)) return null;
  }

  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${process.pid}\n`);
  if (holderPid(path) !== process.pid) return null;
  return priorMtime ?? 0;
}

/** dream 失败/被杀后回滚锁 mtime（best-effort，失败只是推迟下次自动触发）。 */
export function rollbackConsolidationLock(memoryDir: string, priorMtime: number): void {
  const path = lockPath(memoryDir);
  try {
    if (priorMtime <= 0) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    atomicWrite(path, "");
    utimesSync(path, priorMtime, priorMtime);
  } catch {
    // best-effort
  }
}

/** 手动整合后打时间戳。 */
export function recordConsolidation(memoryDir: string): void {
  const path = lockPath(memoryDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${process.pid}\n`);
}

/**
 * since 之后被触碰过的会话快照 ID（新→旧去重；排除当前会话）。
 * 与 Python 差异：TS 会话文件是 `<id>.json`（无 session- 前缀约定），
 * 兼容两种命名；ID 优先取 JSON 里的 session_id/id 字段。
 */
export function listSessionsTouchedSince(
  sessionDir: string,
  sinceTs: number,
  currentSessionId?: string,
): string[] {
  if (!existsSync(sessionDir)) return [];
  const entries = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(sessionDir, name);
      try {
        return { path, name, mtime: statSync(path).mtimeMs / 1000 };
      } catch {
        return null;
      }
    })
    .filter((e): e is { path: string; name: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime);

  const sessionIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.mtime <= sinceTs) continue;
    let sessionId = basename(entry.name, ".json").replace(/^session-/, "");
    try {
      const payload = JSON.parse(readFileSync(entry.path, "utf-8")) as Record<string, unknown>;
      const rawId = payload.session_id ?? payload.id;
      if (typeof rawId === "string" && rawId.trim()) sessionId = rawId.trim();
    } catch {
      // 用文件名兜底
    }
    if (currentSessionId && sessionId === currentSessionId) continue;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    sessionIds.push(sessionId);
  }
  return sessionIds;
}
