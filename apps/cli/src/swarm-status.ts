import type { TaskInfo, TaskEvent } from "@openharness/services";

/**
 * 前端 SwarmPanel 期望的 teammate 快照形状（对齐
 * apps/frontend/src/types/index.ts 的 SwarmTeammateSnapshot）。
 *
 * 注意：前端的 status 枚举只有 4 个值（running/idle/done/error），与设计文档
 * 里写的 spawned/running/completed/failed 不一致——以**前端实际消费的枚举为准**，
 * 否则 SwarmPanel 的 statusIcon 会落空。映射取舍见下方 taskStatusToSwarmStatus。
 */
export type SwarmTeammateSnapshot = {
  name: string;
  status: "running" | "idle" | "done" | "error";
  duration?: number;
  task?: string;
};

/**
 * 把 TaskInfo.status（pending/running/completed/failed/stopped）收敛到前端的
 * 4 值枚举：
 * - running / pending → "running"（pending 视为「即将运行」，仍显示绿点）
 * - completed（exitCode === 0）→ "done"
 * - failed / 非 0 退出 → "error"
 * - stopped → "error"（被显式终止，按异常结束呈现）
 */
export function taskStatusToSwarmStatus(task: TaskInfo): SwarmTeammateSnapshot["status"] {
  switch (task.status) {
    case "completed":
      // exitCode 缺省按 0（completed 语义即正常退出）。
      return (task.exitCode ?? 0) === 0 ? "done" : "error";
    case "failed":
    case "stopped":
      return "error";
    case "running":
    case "pending":
    default:
      return "running";
  }
}

/**
 * TaskInfo → SwarmTeammateSnapshot 的纯映射。
 *
 * - name：用 taskId 作为稳定唯一键（前端 SwarmPanel 用 teammate.name 作 React key，
 *   而 description 形如 "Explore@default" 可能重名）。description 进 task 字段。
 * - duration：有 startedAt 时按 (finishedAt | now) - startedAt 计算（秒，向下取整）。
 * - task：用 description 作为人类可读标签。
 *
 * 传入 `now` 便于测试确定性（默认 Date.now()）。
 */
export function taskInfoToTeammateSnapshot(
  task: TaskInfo,
  now: number = Date.now(),
): SwarmTeammateSnapshot {
  const snapshot: SwarmTeammateSnapshot = {
    name: task.id,
    status: taskStatusToSwarmStatus(task),
    task: task.description,
  };
  if (task.startedAt != null) {
    const end = task.finishedAt ?? now;
    snapshot.duration = Math.max(0, Math.floor((end - task.startedAt) / 1000));
  }
  return snapshot;
}

/** 仅处理 agent 型任务（teammate）；shell 型任务不进 swarm 面板。 */
export function isTeammateTask(task: TaskInfo): boolean {
  return task.type === "agent";
}

/**
 * 根据一次任务生命周期事件，更新 teammate 快照 map（按 taskId 索引），返回
 * 是否发生了变更（用于决定是否 emit）。**就地修改传入的 map**（调用方持有它）。
 *
 * - 非 agent 型任务：忽略，返回 false。
 * - created / updated / completed：都把最新快照写入（completed 会覆盖为终态）。
 *
 * 抽成纯函数（除了对 map 的就地写入外无副作用）以便单测：断言 map 内容与返回值。
 */
export function applyTaskEventToSnapshotMap(
  snapshots: Map<string, SwarmTeammateSnapshot>,
  task: TaskInfo,
  _event: TaskEvent,
  now: number = Date.now(),
): boolean {
  if (!isTeammateTask(task)) return false;
  snapshots.set(task.id, taskInfoToTeammateSnapshot(task, now));
  return true;
}

/**
 * 把快照 map 拍平成前端 swarm_status 事件的 teammate 列表，按 taskId（创建顺序的
 * 近似）稳定排序，保证渲染顺序确定。
 */
export function snapshotMapToList(
  snapshots: Map<string, SwarmTeammateSnapshot>,
): SwarmTeammateSnapshot[] {
  return [...snapshots.values()];
}
