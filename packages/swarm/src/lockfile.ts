import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/**
 * 跨平台排他文件锁（移植自 Python utils/file_lock.py，原语不同）。
 *
 * Python 用 flock(POSIX)/msvcrt.locking(Windows)，进程退出由 OS 自动释放；
 * Node 没有对应原语，改用「`wx` 独占创建锁文件」实现互斥：
 * - 获取：open(lockPath, "wx") 成功即持有；EEXIST 则每 retryIntervalMs 重试。
 * - 崩溃恢复：锁文件 mtime 超过 staleMs 视为持有者已死，删除后重试（陈旧回收）。
 * - 释放：临界区结束（含抛错）unlink 锁文件。
 *
 * 用于串行化共享 JSON 的读-改-写（swarm 邮箱、permission pending 目录等），
 * 与 `.tmp` + rename 原子写配合，让临界区既无竞态又崩溃安全。
 */

export class SwarmLockError extends Error {}

export interface ExclusiveFileLockOptions {
  /** 锁被占用时的重试间隔，缺省 50ms。 */
  retryIntervalMs?: number;
  /** 锁文件多旧视为陈旧（持有者崩溃），缺省 10s。 */
  staleMs?: number;
  /** 获取锁的总超时，超过抛 SwarmLockError，缺省 30s。 */
  timeoutMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function acquire(lockPath: string, options: Required<ExclusiveFileLockOptions>): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  await fs.mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.close();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }

    // 锁被占用：先看是否陈旧（持有者崩溃残留），是则删掉立刻重试。
    try {
      const st = await fs.stat(lockPath);
      if (Date.now() - st.mtimeMs > options.staleMs) {
        await fs.unlink(lockPath).catch(() => {});
        continue;
      }
    } catch {
      // 锁文件在 stat 前被释放了，立刻重试获取。
      continue;
    }

    if (Date.now() >= deadline) {
      throw new SwarmLockError(`Timed out acquiring file lock: ${lockPath}`);
    }
    await sleep(options.retryIntervalMs);
  }
}

export async function exclusiveFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options?: ExclusiveFileLockOptions,
): Promise<T> {
  const resolved: Required<ExclusiveFileLockOptions> = {
    retryIntervalMs: options?.retryIntervalMs ?? 50,
    staleMs: options?.staleMs ?? 10_000,
    timeoutMs: options?.timeoutMs ?? 30_000,
  };
  await acquire(lockPath, resolved);
  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
}
