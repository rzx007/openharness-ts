import {
  type PermissionDecider,
  createPermissionRequest,
  writePermissionRequest,
  pollForResponse,
  deleteResolvedPermission,
  readPendingPermissions,
  resolvePermission,
  handlePermissionRequest,
  cleanupSessionTeamsSync,
} from "@openharness/swarm";
import type { PermissionPromptFn } from "./runtime.js";

/**
 * Swarm 权限同步接线（D.5，TS 扩展——Python 原版的 permission_sync 是未接线的库）。
 *
 * worker 侧：teammate 子进程（`--swarm-worker` + swarm env）把 QueryEngine 的
 * permissionPrompt 接到文件流——写 pending 请求，阻塞轮询 leader 裁决。
 * 写操作从「`--print` 无确认即拒」变「转 leader 审批」。
 *
 * leader 侧：后台定时器轮询被 watch 团队的 pending 目录，按 leader 自己的
 * PermissionChecker 自动裁决（allow→批、deny/ask→拒；只读直批），写回 resolved。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// worker 侧：permissionPrompt → 文件流
// ---------------------------------------------------------------------------

/**
 * 构造 swarm worker 的 permissionPrompt：写 pending 请求 → 轮询裁决（缺省
 * 0.5s 间隔、60s 超时）→ approved 放行。无 team env（不是 worker）直接拒。
 */
export function buildSwarmWorkerPermissionPrompt(options?: {
  timeoutMs?: number;
  intervalMs?: number;
}): PermissionPromptFn {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const intervalMs = options?.intervalMs ?? 500;

  return async (toolName, reason, input) => {
    const request = createPermissionRequest({
      toolName,
      toolUseId: "",
      toolInput: input ?? {},
      description: reason ?? "",
    });
    if (!request.teamName) return false;

    await writePermissionRequest(request);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await pollForResponse(request.id, request.teamName);
      if (response) {
        await deleteResolvedPermission(request.id, request.teamName);
        return response.decision === "approved";
      }
      await sleep(intervalMs);
    }
    return false; // 超时按拒绝处理（leader 可能已退出）
  };
}

// ---------------------------------------------------------------------------
// leader 侧：pending 轮询 + 自动裁决
// ---------------------------------------------------------------------------

const watchedTeams = new Set<string>();
let resolverTimer: NodeJS.Timeout | null = null;
let exitHookInstalled = false;

/** 把一个团队纳入 leader 的权限轮询范围（spawn teammate 时调用）。 */
export function watchTeamForPermissions(teamName: string): void {
  watchedTeams.add(teamName);
}

/** 轮询一轮：逐团队读 pending → 裁决 → 写 resolved。返回处理的请求数（测试用）。 */
export async function pollSwarmPermissionsOnce(
  checker: PermissionDecider,
  readOnlyTools: ReadonlySet<string>,
): Promise<number> {
  let handled = 0;
  for (const team of watchedTeams) {
    const pending = await readPendingPermissions(team);
    for (const request of pending) {
      const response = await handlePermissionRequest(request, checker, readOnlyTools);
      const ok = await resolvePermission(
        request.id,
        {
          decision: response.allowed ? "approved" : "rejected",
          resolvedBy: "leader",
          feedback: response.feedback,
        },
        team,
      );
      if (ok) handled += 1;
    }
  }
  return handled;
}

/**
 * 启动 leader 后台裁决轮询（幂等；缺省 1s 间隔）。定时器 unref——不阻进程退出；
 * 同时装一次性 exit 钩子，退出时同步清理本会话创建的团队目录。
 */
export function startSwarmPermissionResolver(
  checker: PermissionDecider,
  readOnlyTools: ReadonlySet<string>,
  options?: { intervalMs?: number },
): void {
  if (resolverTimer) return;
  const intervalMs = options?.intervalMs ?? 1_000;
  resolverTimer = setInterval(() => {
    void pollSwarmPermissionsOnce(checker, readOnlyTools).catch(() => {});
  }, intervalMs);
  resolverTimer.unref?.();

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", cleanupSessionTeamsSync);
  }
}

export function stopSwarmPermissionResolver(): void {
  if (resolverTimer) {
    clearInterval(resolverTimer);
    resolverTimer = null;
  }
}

/** 测试隔离：清空 watch 集合与定时器（不卸 exit 钩子，幂等无害）。 */
export function _resetSwarmPermissionStateForTests(): void {
  stopSwarmPermissionResolver();
  watchedTeams.clear();
}
