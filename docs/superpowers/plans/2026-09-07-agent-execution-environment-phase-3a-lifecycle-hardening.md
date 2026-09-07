# Agent 执行环境第三阶段 3A 生命周期加固实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 内联逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度；不调度子代理。

**目标：** 让 Desktop 在不重启应用的情况下安全切换本机与 Docker Agent 环境，并在 daemon 崩溃或重启后可靠完成切换、清理可确认的孤儿容器和旧 exec，全程只保留一个最新配置版本。

**架构：** `DaemonOperationGate` 负责阻止新会话工作并等待正在执行的请求结束，`ExecutionEnvironmentManager` 负责阻止新环境 lease 并等待 Agent、终端和后台任务释放。`EnvironmentSwitchService` 是唯一切换编排入口：先预检候选设置，再持久化切换意图，排空旧环境，原子保存设置，清理旧资源并探测新环境。Docker 容器和 exec 携带稳定 installation、daemon generation、environment 和 workspace owner 标记；daemon 启动时只清理能够证明属于当前安装且属于旧 generation 的资源，无法证明所有权时 fail-closed。

**技术栈：** TypeScript、Vitest、SQLite/better-sqlite3、Hono HTTP、Electron IPC、Docker CLI、Turbo、GitHub Actions。

---

## 范围与不可变约束

第三阶段包含四个可独立验收的子阶段：

1. **3A 生命周期加固（本计划）：** 热切换、持久切换状态、owner 标记、崩溃恢复和 orphan reconciliation。
2. **3B Native Plugin 环境化：** 将 Native Tool Host 改为环境进程，并把已验证插件副本安全送入容器。
3. **3C Skill 与工作区生命周期：** system prompt 的 Skill 变更感知、工作区引用统计和独立清理入口。
4. **3D 跨平台 Docker CI：** 在确实提供 Linux Docker daemon 的 runner 上执行真实 E2E，并保留 Windows/macOS 的本地验证证据。

3B–3D 不与 3A 共用实现提交。3A 完成后分别编写计划，避免 Native Plugin 协议、危险目录删除和 CI runner 差异干扰环境切换的正确性。

本计划固定以下行为：

- 同一 workspace owner 不并存两个配置版本，也不把 config hash 放进容器名。
- 不保存 Session 的历史环境配置，不恢复旧镜像、旧网络或旧挂载。
- 持久记录只保存一次切换的 source/target 设置摘要、受影响 owner 和阶段，不保存可长期恢复的旧配置快照。
- 切换开始后，新 run、新 Agent、默认用户 Docker 终端、Agent Terminal 和后台任务立即拒绝进入。
- 已在执行的 run 自然排空；用户终端和后台任务不会被设置更新静默杀掉。存在这些 blocker 时，切换取消且设置不落盘，UI 明确提示用户先关闭。
- warm Agent 可以由服务端自动关闭，因为它没有正在执行的 run。
- 设置成功落盘后若新环境探测失败，状态为 `unavailable`；不恢复旧容器，也不回退到宿主执行。
- 显式本机终端不持有环境 lease，不阻塞 Docker 环境切换。
- orphan 清理只处理同时带有 managed 与当前 installation 标记的资源；标记缺失或冲突时只报告，不删除。
- 第二阶段遗留且没有 installation label 的复用容器按“所有权无法验证”处理：不自动接管或删除，错误信息给出精确容器名并要求用户手动确认处理；不增加兼容迁移分支。

## 文件职责总览

### 新建文件

- `packages/services/src/session-runtime/environment-lifecycle.ts`：持久切换记录与 installation identity 类型、解析和校验。
- `packages/services/src/session-runtime/environment-lifecycle.test.ts`：SQLite 重开、owner fence 和切换记录 CAS 测试。
- `packages/services/src/session-runtime/migrations/0017_environment_lifecycle.sql`：installation identity 和单活动切换记录表。
- `packages/sandbox/src/docker-resource-inventory.ts`：列举、解析和验证 OHS Docker 容器及容器内 exec 标记。
- `packages/sandbox/src/docker-resource-inventory.test.ts`：Docker CLI 输出解析和所有权验证测试。
- `packages/sandbox/src/docker-orphan-reconciler.ts`：基于 installation/generation/live owner 的保守清理策略。
- `packages/sandbox/src/docker-orphan-reconciler.test.ts`：临时容器、复用容器、旧 exec 和未知所有权测试。
- `packages/server/src/application/environment/environment-switch-service.ts`：热切换事务编排。
- `packages/server/src/application/environment/environment-switch-service.test.ts`：排空、blocker、提交点和失败语义测试。
- `packages/server/src/application/environment/environment-recovery.ts`：daemon 启动时的切换恢复与 orphan reconciliation。
- `packages/server/src/application/environment/environment-recovery.test.ts`：崩溃阶段恢复测试。
- `packages/server/src/http/routes/environment.ts`：环境状态与切换 HTTP API。
- `packages/server/src/http/routes/environment.test.ts`：协议校验、状态码和错误映射测试。
- `packages/protocol/src/environment-lifecycle.ts`：跨 HTTP/Desktop 的环境切换状态 DTO。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/environment-switch-model.ts`：设置页状态文案与 blocker 展示模型。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/environment-switch-model.test.ts`：UI 状态模型测试。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-control.test.tsx`：设置页切换交互测试。
- `packages/server/e2e/environment-switch.e2e.test.ts`：真实 Docker 热切换和崩溃清理 E2E。

### 修改文件

- `packages/environment/src/types.ts`：统一生命周期状态、运行身份和 maintenance consumer。
- `packages/sandbox/src/execution-environment-manager.ts`：全局 drain/switch barrier、blocker 快照和状态迁移。
- `packages/sandbox/src/execution-environment-manager.test.ts`：并发 acquire/release 与单版本不变量。
- `packages/sandbox/src/docker-backend.ts`：容器 label、exec 环境标记和严格所有权校验。
- `packages/sandbox/src/execution-environment.ts`：把 Manager 分配的运行身份传入 Docker Session。
- `packages/sandbox/src/lifecycle.ts`：启动参数接收环境身份。
- `packages/sandbox/src/types.ts`：Sandbox Session 身份与诊断类型。
- `packages/sandbox/src/index.ts`：导出 inventory、reconciler 和身份常量。
- `packages/server/src/application/control/daemon-operation-gate.ts`：先关门、后等待的异步 barrier。
- `packages/server/src/application/control/__test__/daemon-operation-gate.test.ts`：drain 期间新请求拒绝和超时测试。
- `packages/server/src/application/default-services/settings-service.ts`：设置候选准备与原子提交拆分。
- `packages/server/src/application/settings-api.ts`：PreparedSettingsPatch 契约。
- `packages/server/src/application/daemon-application.ts`：装配 SwitchService，按固定顺序执行启动恢复。
- `packages/server/src/runtime/session-execution-environment.ts`：把 installation/daemon identity 交给 Manager。
- `packages/server/src/terminal/daemon-terminal-service.ts`：为 PTY 注入 terminal owner 标记。
- `packages/server/src/application/session/background-shell-service.ts`：为环境进程注入 durable job owner 标记。
- `packages/server/src/http/server.ts`：挂载环境生命周期路由。
- `packages/server/src/http/routes/system.ts`：禁止 `/settings` 绕过环境切换事务。
- `packages/client/src/transport/http-client.ts`：读取环境状态和发起切换。
- `packages/client/src/index.ts`：导出环境生命周期 DTO。
- `packages/protocol/src/index.ts`：导出环境生命周期协议。
- `apps/desktop/src/shared/settings-types.ts`：移除重启假象，加入 current/target/transition。
- `apps/desktop/src/shared/ipc-channels.ts`：环境状态与切换 IPC 返回类型。
- `apps/desktop/src/shared/desktop-api-contract.ts`：设置变更订阅契约。
- `apps/desktop/src/main/features/settings/ipc.ts`：切换完成后向 Renderer 发布权威状态。
- `apps/desktop/src/main/features/settings/settings-service.ts`：调用 daemon 切换 API。
- `apps/desktop/src/main/features/settings/settings-service.test.ts`：预检、blocker、成功与 unavailable 测试。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-control.tsx`：切换进度、阻塞项和失败展示。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-model.ts`：删除“重启后生效”文案。
- `apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx`：订阅环境变化，确保下一次新建终端使用最新环境。
- `packages/server/package.json`：增加环境切换 Docker E2E 脚本。
- `.github/workflows/ci.yml`：增加 Ubuntu Docker 生命周期 E2E job。
- `docs/sandbox-runtime-flow.md`：记录第三阶段实际调用链和恢复规则。
- `docs/superpowers/specs/2026-09-07-agent-runtime-environment-and-terminal-design.md`：只勾选有自动化证据的 3A 条目。

## 任务 1：持久化 installation identity 与切换状态

**文件：**

- 创建：`packages/services/src/session-runtime/environment-lifecycle.ts`
- 创建：`packages/services/src/session-runtime/environment-lifecycle.test.ts`
- 创建：`packages/services/src/session-runtime/migrations/0017_environment_lifecycle.sql`
- 修改：`packages/services/src/session-runtime/migrations/meta/_journal.json`
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/index.ts`
- 修改：`packages/services/src/index.ts`

- [ ] **步骤 1：编写失败的 SQLite 重开与 CAS 测试**

测试使用临时数据库，覆盖：同一数据库重开后 installation ID 不变；切换记录完整保留；只有匹配 `transitionId` 和当前 application owner generation 的写入才能推进阶段；旧 daemon generation 不能覆盖新 daemon 写入。

```ts
const first = new SessionStore({ path: databasePath })
const owner1 = first.acquireApplicationOwner({ ownerId: "daemon-1", pid: 11, staleAfterMs: 1 })
const installationId = first.getOrCreateInstallationId()
first.putEnvironmentSwitch(owner1, {
  transitionId: "switch-1",
  phase: "draining",
  sourceSettingsHash: "source",
  targetSettingsHash: "target",
  targetKind: "docker",
  owners: [{ ownerId: "session:s1", rootSessionId: "s1", hostRoot: "D:\\repo" }],
  requestedAt: 100,
  updatedAt: 100,
})
first.releaseApplicationOwner(owner1)
first.close()

const second = new SessionStore({ path: databasePath })
expect(second.getOrCreateInstallationId()).toBe(installationId)
expect(second.getEnvironmentSwitch()).toMatchObject({
  transitionId: "switch-1",
  phase: "draining",
  targetSettingsHash: "target",
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：

```bash
pnpm --filter @openharness/services test -- environment-lifecycle.test.ts
```

预期：FAIL，`getOrCreateInstallationId`、`putEnvironmentSwitch` 和 migration 0017 尚不存在。

- [ ] **步骤 3：实现最小持久模型**

定义：

```ts
export type EnvironmentSwitchPhase =
  | "draining"
  | "switching"
  | "ready"
  | "unavailable"

export interface EnvironmentSwitchOwner {
  ownerId: string
  rootSessionId: string
  hostRoot: string
  sourceConfigHash?: string
  targetConfigHash?: string
}

export interface EnvironmentSwitchRecord {
  transitionId: string
  phase: EnvironmentSwitchPhase
  sourceSettingsHash: string
  targetSettingsHash: string
  targetKind: "local" | "docker"
  owners: EnvironmentSwitchOwner[]
  error?: string
  requestedAt: number
  updatedAt: number
}
```

Migration 使用单行 `application_identity(key='installation')` 和单活动记录 `environment_switch(key='active')`。`owners` 写成 JSON；读取时逐字段校验，损坏记录抛出 `invalid_environment_switch_record`，不能猜测恢复。

Store API：

```ts
getOrCreateInstallationId(): string
getEnvironmentSwitch(): EnvironmentSwitchRecord | undefined
putEnvironmentSwitch(owner: ApplicationOwnerLease, record: EnvironmentSwitchRecord): void
advanceEnvironmentSwitch(
  owner: ApplicationOwnerLease,
  expected: { transitionId: string; phase: EnvironmentSwitchPhase },
  next: EnvironmentSwitchRecord,
): void
clearEnvironmentSwitch(owner: ApplicationOwnerLease, transitionId: string): void
```

所有 mutation 先调用 `assertApplicationOwner(owner)`，并在单个 SQLite transaction 中比较旧 phase 后写入。

- [ ] **步骤 4：运行 Services 测试和类型检查**

```bash
pnpm --filter @openharness/services test -- environment-lifecycle.test.ts store.test.ts
pnpm --filter @openharness/services check-types
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/services
git commit -m "feat(runtime): persist environment switch state (task 1/13)"
```

## 任务 2：让 Environment Manager 支持 drain 与 switch barrier

**文件：**

- 修改：`packages/environment/src/types.ts`
- 修改：`packages/sandbox/src/execution-environment-manager.ts`
- 修改：`packages/sandbox/src/execution-environment-manager.test.ts`

- [ ] **步骤 1：编写失败的状态机测试**

覆盖：`beginDrain()` 立即阻止新 acquire；旧 lease 仍可正常使用并释放；等待直到所有 lease 为零；blocker 快照按 `agent/terminal/background` 返回；取消 drain 恢复 ready；进入 switching 后不能取消回旧配置；任何时刻同一 owner 只有一个 handle。

```ts
const agent = await manager.acquire(request("owner-1", "hash-1", "agent", "s1", create))
const drain = manager.beginDrain({ transitionId: "switch-1" })

await expect(manager.acquire(
  request("owner-1", "hash-1", "terminal", "t2", create),
)).rejects.toMatchObject({ code: "environment_draining" })
expect(drain.blockers()).toEqual([
  expect.objectContaining({ ownerId: "owner-1", kind: "agent", consumerId: "s1" }),
])

const waiting = drain.waitForIdle({ timeoutMs: 100 })
await agent.release()
await expect(waiting).resolves.toBeUndefined()
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @openharness/sandbox test -- execution-environment-manager.test.ts
```

预期：FAIL，Manager 只有 `preparing/ready/failed/stopped`，没有 drain API。

- [ ] **步骤 3：实现全局单切换状态机**

增加共享类型：

```ts
export type ExecutionEnvironmentState =
  | "preparing"
  | "ready"
  | "draining"
  | "switching"
  | "unavailable"
  | "stopped"
  | "failed"

export type ExecutionEnvironmentConsumerKind =
  | "agent"
  | "terminal"
  | "background"
  | "maintenance"
```

Manager 只允许一个活动 drain：

```ts
beginDrain(input: { transitionId: string }): ExecutionEnvironmentDrain
list(): ExecutionEnvironmentInspection[]
markUnavailable(ownerId: string, message: string): void
```

`ExecutionEnvironmentDrain` 提供 `blockers()`、`waitForIdle()`、`markSwitching()`、`acquireMaintenance()`、`finish()` 和 `cancel()`。`cancel()` 仅允许发生在设置提交前；`markSwitching()` 后失败只能 `finish({ state: "unavailable" })`。普通 `manager.acquire()` 在 drain/switching 期间一律拒绝；只有同一个 transition handle 在 `switching` 后可以通过 `acquireMaintenance()` 创建目标探测 lease，且这些 lease 不计入用户 blocker。等待使用 release 事件，不使用轮询或固定 sleep。

- [ ] **步骤 4：运行 Manager 全套测试和类型检查**

```bash
pnpm --filter @openharness/environment test
pnpm --filter @openharness/sandbox test -- execution-environment-manager.test.ts
pnpm --filter @openharness/sandbox check-types
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/environment packages/sandbox/src/execution-environment-manager.ts packages/sandbox/src/execution-environment-manager.test.ts
git commit -m "feat(environment): drain leases before switching (task 2/13)"
```

## 任务 3：让 Daemon Operation Gate 先关门再等待

**文件：**

- 修改：`packages/server/src/application/control/daemon-operation-gate.ts`
- 修改：`packages/server/src/application/control/__test__/daemon-operation-gate.test.ts`

- [ ] **步骤 1：编写失败的异步 barrier 测试**

```ts
const active = gate.enter({ sessionId: "s1", cwd: "D:\\repo" })
const barrier = gate.beginBarrier({ kind: "global" })

expect(() => gate.enter({ sessionId: "s2", cwd: "D:\\other" }))
  .toThrowError(/blocked/)
await expect(barrier.waitForDrain({ timeoutMs: 5 }))
  .rejects.toMatchObject({ code: "daemon_operation_drain_timeout" })

active.release()
await barrier.waitForDrain({ timeoutMs: 100 })
barrier.release()
```

同时覆盖两个并发 global barrier 只有一个成功，shutdown 能等待 barrier 释放。

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @openharness/server test -- daemon-operation-gate.test.ts
```

预期：FAIL，当前 `tryEnterBarrier` 只能在已经 idle 时进入。

- [ ] **步骤 3：实现 `beginBarrier()`**

新增：

```ts
export interface DaemonOperationDrainLease extends DaemonOperationLease {
  waitForDrain(input: { timeoutMs: number; signal?: AbortSignal }): Promise<void>
}
```

`beginBarrier()` 先登记 barrier，再等待与其冲突的 shared operation 清零。超时只结束等待，不自动释放 barrier；调用方必须在 `finally` 中 release。现有 `tryEnterBarrier()` 保留给 archive/delete 等即时 409 场景。

- [ ] **步骤 4：运行 Gate 与 Session 服务测试**

```bash
pnpm --filter @openharness/server test -- daemon-operation-gate.test.ts session-application-service.test.ts
pnpm --filter @openharness/server check-types
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/server/src/application/control
git commit -m "feat(server): add draining mutation barriers (task 3/13)"
```

## 任务 4：建立稳定运行身份并贯穿环境创建

**文件：**

- 修改：`packages/environment/src/types.ts`
- 修改：`packages/sandbox/src/execution-environment-manager.ts`
- 修改：`packages/sandbox/src/execution-environment.ts`
- 修改：`packages/sandbox/src/lifecycle.ts`
- 修改：`packages/sandbox/src/types.ts`
- 修改：`packages/server/src/runtime/session-execution-environment.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：对应单元测试

- [ ] **步骤 1：编写失败的身份传递测试**

```ts
expect(createEnvironment).toHaveBeenCalledWith(expect.objectContaining({
  identity: {
    installationId: "install-1",
    daemonOwnerId: "daemon-1",
    daemonGeneration: 7,
    environmentId: expect.any(String),
    workspaceOwnerId: "project:d:/repo",
    configHash: expect.any(String),
  },
}))
```

验证 `environmentId` 由 Manager 在调用 `create()` 前生成，同一个 record 的所有 lease 一致，新 record 才生成新 ID。

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @openharness/sandbox test -- execution-environment-manager.test.ts execution-environment.test.ts
pnpm --filter @openharness/server test -- session-execution-environment.test.ts
```

预期：FAIL，`create()` 当前不接收 Manager 身份。

- [ ] **步骤 3：实现身份契约**

```ts
export interface ExecutionEnvironmentIdentity {
  installationId: string
  daemonOwnerId: string
  daemonGeneration: number
  environmentId: string
  workspaceOwnerId: string
  configHash: string
}
```

将 `AcquireExecutionEnvironmentRequest.create` 改为：

```ts
create(identity: ExecutionEnvironmentIdentity): Promise<ExecutionEnvironmentHandle>
```

`DaemonApplication` 在取得 application owner lease 后读取稳定 installation ID，并将二者注入 `createSessionEnvironmentAcquirer`。Agent 核心只收到已经创建好的环境 lease，不感知 daemon generation 或 Docker label。

- [ ] **步骤 4：运行受影响包测试和类型检查**

```bash
pnpm --filter @openharness/environment test
pnpm --filter @openharness/sandbox test
pnpm --filter @openharness/server test -- daemon-agent.test.ts session-execution-environment.test.ts
pnpm --filter @openharness/server check-types
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/environment packages/sandbox packages/server
git commit -m "refactor(runtime): propagate environment identity (task 4/13)"
```

## 任务 5：为 Docker 容器写入可验证 owner labels

**文件：**

- 修改：`packages/sandbox/src/docker-backend.ts`
- 修改：`packages/sandbox/src/index.test.ts`
- 修改：`packages/sandbox/e2e/docker.e2e.test.ts`

- [ ] **步骤 1：编写失败的 Docker argv 与复用校验测试**

期望 `docker run` 至少包含：

```text
org.openharness.sandbox.managed=true
org.openharness.sandbox.installation=install-1
org.openharness.sandbox.workspace-owner=project:d:/repo
org.openharness.sandbox.config-hash=<hash>
org.openharness.sandbox.reusable=true|false
org.openharness.sandbox.created-by-owner=daemon-1
org.openharness.sandbox.created-by-generation=7
org.openharness.sandbox.environment-id=<id>
```

测试还要证明：同名容器只有 workspace 路径相同但 installation 不同，不能删除或复用；installation 与 workspace owner 一致但 hash 过期，才允许按单版本策略替换。

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @openharness/sandbox test -- index.test.ts
```

预期：FAIL，当前只有 managed/config-hash/workspace 三个 label。

- [ ] **步骤 3：实现 label 与严格复用规则**

集中导出 label 常量，`DockerRunArgsOptions` 必须接收 `identity`。`prepareReusableContainer()` 的删除条件改为同时满足：managed=true、installation 一致、workspace owner 一致、规范化 workspace 一致；任何一个缺失都抛出 `docker_container_ownership_unverified`。

旧容器 hash 匹配时可复用，即使 created-by generation 已旧；generation 表示创建者，不伪装成当前持有者。当前 daemon 对 exec 的所有权由任务 6 的进程标记表达。

- [ ] **步骤 4：运行 Sandbox 单元与真实 Docker 复用测试**

```bash
pnpm --filter @openharness/sandbox test -- index.test.ts
pnpm --filter @openharness/sandbox e2e:docker
```

预期：单元测试通过；Docker E2E 中 9 个默认用例通过，bridge 外网用例继续显式 skip，且同 owner 不出现第二个容器。

- [ ] **步骤 5：Commit**

```bash
git add packages/sandbox
git commit -m "feat(sandbox): label managed environment owners (task 5/13)"
```

## 任务 6：为 Docker exec 与 PTY 写入运行 owner 标记

**文件：**

- 修改：`packages/environment/src/types.ts`
- 修改：`packages/sandbox/src/docker-backend.ts`
- 修改：`packages/sandbox/src/execution-environment.ts`
- 修改：`packages/terminal-node/src/environment-terminal-target.ts`
- 修改：`packages/server/src/terminal/daemon-terminal-service.ts`
- 修改：`packages/server/src/application/session/background-shell-service.ts`
- 修改：对应测试

- [ ] **步骤 1：编写失败的 exec 环境标记测试**

```ts
expect(buildDockerExecArgs(input)).toEqual(expect.arrayContaining([
  "-e", "OPENHARNESS_INSTALLATION_ID=install-1",
  "-e", "OPENHARNESS_DAEMON_GENERATION=7",
  "-e", "OPENHARNESS_ENVIRONMENT_ID=env-1",
  "-e", "OPENHARNESS_EXECUTION_KIND=background",
  "-e", "OPENHARNESS_EXECUTION_ID=task-1",
]))
```

PTY 断言 `executionKind=terminal`、`executionId=terminalId`；普通 Agent 命令没有 durable job ID 时使用 Sandbox Session 生成的 execution ID。

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @openharness/sandbox test -- index.test.ts
pnpm --filter @openharness/terminal-node test
pnpm --filter @openharness/server test -- daemon-terminal-service.test.ts background-shell-service.test.ts
```

预期：FAIL，当前 exec 只给 PTY 写 `OPENHARNESS_PTY_ID`。

- [ ] **步骤 3：扩展进程 owner 契约**

```ts
export interface EnvironmentExecutionOwner {
  kind: "agent" | "terminal" | "background" | "hook" | "mcp" | "maintenance"
  id: string
}

export interface EnvironmentProcessOptions {
  cwd?: string
  env?: Record<string, string>
  owner?: EnvironmentExecutionOwner
  signal?: AbortSignal
}
```

Sandbox 后端保留内部随机 execution ID 作为进程组 marker，同时把稳定 owner 元数据注入顶层 supervisor 及其子进程。过滤用户传入的所有 `OPENHARNESS_*` owner key，调用方不能伪造。Terminal 和 BackgroundShell 使用服务端可信 ID，不接受 Renderer/模型覆盖。

- [ ] **步骤 4：运行相关测试和 Docker PTY E2E**

```bash
pnpm --filter @openharness/sandbox test
pnpm --filter @openharness/terminal-node test
pnpm --filter @openharness/terminal-node e2e:docker
pnpm --filter @openharness/server test -- daemon-terminal-service.test.ts background-shell-service.test.ts
```

预期：全部通过；`tty -s`、resize、Ctrl-C、EOF 和 terminate 行为不变。

- [ ] **步骤 5：Commit**

```bash
git add packages/environment packages/sandbox packages/terminal-node packages/server
git commit -m "feat(runtime): mark owned Docker executions (task 6/13)"
```

## 任务 7：实现 Docker 资源 inventory 与保守 orphan reconciliation

**文件：**

- 创建：`packages/sandbox/src/docker-resource-inventory.ts`
- 创建：`packages/sandbox/src/docker-resource-inventory.test.ts`
- 创建：`packages/sandbox/src/docker-orphan-reconciler.ts`
- 创建：`packages/sandbox/src/docker-orphan-reconciler.test.ts`
- 修改：`packages/sandbox/src/index.ts`

- [ ] **步骤 1：编写失败的纯策略测试**

输入 inventory 后断言：

- 当前 installation 的旧 generation 临时容器：`remove_container`；临时环境依赖内存 lease，daemon 重启后不接管，即使 durable Session 仍存在也由下一次 acquire 按最新配置重建；
- 当前 installation 的复用容器：保留容器，仅 `kill_execution` 清理旧 generation exec；
- 当前 generation exec：保留；
- 另一 installation、managed 缺失、workspace owner 缺失或解析失败：`report_conflict`；
- 同一 container 的 action 去重且顺序固定为 kill exec 后 remove container。

```ts
expect(planDockerOrphanReconciliation(inventory, {
  installationId: "install-1",
  daemonGeneration: 8,
  liveWorkspaceOwnerIds: new Set(["project:d:/live"]),
})).toEqual([
  { kind: "kill_execution", containerName: "reuse", pid: 42, reason: "stale_generation" },
  { kind: "remove_container", containerName: "temp", reason: "orphan_temporary_environment" },
])
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @openharness/sandbox test -- docker-resource-inventory.test.ts docker-orphan-reconciler.test.ts
```

预期：FAIL，新模块尚不存在。

- [ ] **步骤 3：实现 inventory 和执行器**

`listManagedDockerResources()` 使用 Docker CLI：

1. `docker ps -a --filter label=org.openharness.sandbox.managed=true --format '{{json .}}'`；
2. 对候选容器批量 inspect labels/state；
3. 对运行容器执行只读 `/proc/*/environ` 扫描，解析 `OPENHARNESS_*` 标记；
4. 将解析错误作为 diagnostics 返回，不把错误对象当成“没有资源”。

`reconcileDockerOrphans()` 先生成 action plan，再执行。删除容器使用精确 container ID；杀进程先读取 session ID 并终止进程组。每个动作失败单独记录，继续检查其他资源，最后返回结构化报告；未知所有权绝不调用 `docker rm` 或 `kill`。

- [ ] **步骤 4：运行 Sandbox 测试和类型检查**

```bash
pnpm --filter @openharness/sandbox test
pnpm --filter @openharness/sandbox check-types
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/sandbox
git commit -m "feat(sandbox): reconcile owned Docker orphans (task 7/13)"
```

## 任务 8：拆分设置候选准备与原子提交

**文件：**

- 修改：`packages/server/src/application/settings-api.ts`
- 修改：`packages/server/src/application/default-services/settings-service.ts`
- 修改：`packages/server/src/application/__test__/default-application-services.test.ts`
- 修改：`packages/server/src/http/routes/system.ts`
- 修改：`packages/server/src/http/routes/__test__/routes.test.ts`

- [ ] **步骤 1：编写失败的 prepare/commit 测试**

```ts
const prepared = await settings.preparePatch({
  sandbox: { enabled: true, backend: "docker", failIfUnavailable: true },
})
expect(prepared).toMatchObject({
  impact: "environment_switch",
  sourceSettingsHash: expect.any(String),
  targetSettingsHash: expect.any(String),
})
expect(await settings.get()).toMatchObject({ sandbox: { enabled: false } })

await settings.commitPrepared(prepared)
expect(await settings.get()).toMatchObject({ sandbox: { enabled: true, backend: "docker" } })
```

测试篡改 prepared candidate 或 source hash 后提交返回 `settings_candidate_stale`。

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @openharness/server test -- default-application-services.test.ts routes.test.ts
```

预期：FAIL，SettingsService 当前 `patch()` 直接保存。

- [ ] **步骤 3：实现候选 API 和影响分类**

```ts
export interface PreparedSettingsPatch {
  patch: Record<string, unknown>
  current: Record<string, unknown>
  candidate: Record<string, unknown>
  sourceSettingsHash: string
  targetSettingsHash: string
  impact: "restart" | "invalidate" | "environment_switch" | "none"
}
```

`sandbox` 和顶层 `terminal` 归为 `environment_switch`。hash 使用完整归一化 Settings 的稳定 JSON，不使用 Session metadata，也不写 `_formatVersion`。普通 `patch()` 仍供非环境设置使用；`/settings` 收到环境影响 patch 时返回 409 `environment_switch_endpoint_required`，防止绕过任务 10 的事务入口。

- [ ] **步骤 4：运行 Server 设置测试和类型检查**

```bash
pnpm --filter @openharness/server test -- default-application-services.test.ts routes.test.ts
pnpm --filter @openharness/server check-types
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/server/src/application/settings-api.ts packages/server/src/application/default-services packages/server/src/http/routes/system.ts packages/server/src/http/routes/__test__/routes.test.ts
git commit -m "refactor(settings): prepare environment candidates (task 8/13)"
```

## 任务 9：实现 EnvironmentSwitchService 事务编排

**文件：**

- 创建：`packages/server/src/application/environment/environment-switch-service.ts`
- 创建：`packages/server/src/application/environment/environment-switch-service.test.ts`
- 修改：`packages/server/src/application/control/daemon-control-service.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/runtime/environment-owner.ts`

- [ ] **步骤 1：编写失败的切换事务测试**

覆盖四条主路径：

1. 无 blocker：`preflight → persist draining → gate drain → manager drain → close warm agents → persist switching → commit settings → reconcile old → probe target → ready`；
2. terminal/background blocker：返回 409，取消两个 drain，清除 transition，设置不保存；
3. 设置提交前失败：旧环境重新接受 lease；
4. 设置提交后 probe 失败：持久化 unavailable，不恢复 source 设置或旧容器。

```ts
await expect(service.switchEnvironment({
  patch: dockerPatch,
  drainTimeoutMs: 100,
})).resolves.toMatchObject({ phase: "ready", targetKind: "docker" })

expect(calls).toEqual([
  "prepare",
  "preflight",
  "persist:draining",
  "gate:begin",
  "manager:drain",
  "agents:close",
  "persist:switching",
  "settings:commit",
  "docker:reconcile",
  "target:probe",
  "persist:ready",
])
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @openharness/server test -- environment-switch-service.test.ts
```

预期：FAIL，SwitchService 尚不存在。

- [ ] **步骤 3：实现切换编排和 blocker 规则**

公开 API：

```ts
switchEnvironment(input: {
  patch: Record<string, unknown>
  drainTimeoutMs: number
  signal?: AbortSignal
}): Promise<EnvironmentTransitionSnapshot>

snapshot(): EnvironmentTransitionSnapshot
```

具体顺序：

1. `settings.preparePatch()` 并执行目标 Docker preflight；
2. 持久化 `draining`；
3. `operationGate.beginBarrier({kind:"global"})`，立即阻止新 run；
4. `environmentManager.beginDrain()`，立即阻止新环境 lease；
5. 等待会话 operation 清零，随后关闭 warm Agent；
6. 若剩余 blocker 只有 terminal/background，则返回带 kind、consumerId、ownerId 的 409，取消 drain 并保持旧设置；
7. 无 blocker 时推进 `switching`，再调用 `commitPrepared()`；这是不可回滚提交点；
8. 清理旧 generation 资源；对切换前活跃 owner 逐一使用当前 drain handle 的 `acquireMaintenance()` 探测目标环境并立即释放；
9. 全部成功写 `ready` 并开放 admission；任一失败写 `unavailable`，开放 API 但环境工作继续 fail-closed。

`EnvironmentSwitchService` 不直接拼 Docker 命令，只调用 Sandbox reconciler 和现有 environment acquirer。

- [ ] **步骤 4：运行编排、Manager 和 Gate 测试**

```bash
pnpm --filter @openharness/server test -- environment-switch-service.test.ts daemon-operation-gate.test.ts daemon-control-service.test.ts
pnpm --filter @openharness/sandbox test -- execution-environment-manager.test.ts docker-orphan-reconciler.test.ts
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/server/src/application/environment packages/server/src/application/control packages/server/src/application/daemon-application.ts packages/server/src/runtime/environment-owner.ts
git commit -m "feat(server): switch execution environments live (task 9/13)"
```

## 任务 10：实现 daemon 启动恢复

**文件：**

- 创建：`packages/server/src/application/environment/environment-recovery.ts`
- 创建：`packages/server/src/application/environment/environment-recovery.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/__test__/durable-agent-application.test.ts`

- [ ] **步骤 1：编写失败的崩溃阶段恢复测试**

构造并重开真实 SQLite Store，覆盖：

- `draining` 且当前 settings hash 等于 source：确认设置尚未提交，清理 transition 并保留 source；
- `draining/switching` 且当前 hash 等于 target：清理旧 generation orphan，按 target 探测 affected owners，成功写 ready；
- 当前 hash 同时不等于 source/target：写 unavailable `environment_switch_settings_conflict`；
- target Docker 不可用：写 unavailable，Agent 获取环境继续失败；
- stale daemon 的恢复写入被 application owner generation fence 拒绝。

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @openharness/server test -- environment-recovery.test.ts durable-agent-application.test.ts
```

预期：FAIL，DaemonApplication 启动恢复尚未读取环境切换记录。

- [ ] **步骤 3：按固定启动顺序接入恢复**

顺序固定为：

```text
打开 Store
→ 取得 application owner lease/generation
→ 读取 installation ID
→ 读取 environment switch 和当前 Settings
→ reconcile 旧 generation Docker 资源
→ 按 source/target hash 继续或终止 environment switch
→ 原有 workflow/background/projection recovery
→ ready
```

恢复期间 `assertReady()` 继续拒绝会话、终端和设置 API。恢复失败不能被 `void promise.catch()` 吞掉；应用状态置为 failed，`ready()` 返回原始错误。orphan diagnostics 写 observability log，未知所有权冲突不阻止本机模式启动，但会使对应 Docker owner unavailable。

- [ ] **步骤 4：运行 Daemon 恢复与关闭测试**

```bash
pnpm --filter @openharness/server test -- environment-recovery.test.ts durable-agent-application.test.ts durability-boundaries.test.ts
pnpm --filter @openharness/server check-types
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/server/src/application/environment packages/server/src/application/daemon-application.ts packages/server/src/application/__test__
git commit -m "feat(server): recover interrupted environment switches (task 10/13)"
```

## 任务 11：增加环境状态 HTTP/Client 协议

**文件：**

- 创建：`packages/protocol/src/environment-lifecycle.ts`
- 修改：`packages/protocol/src/index.ts`
- 修改：`packages/protocol/src/serialization.ts`
- 修改：`packages/protocol/src/serialization.test.ts`
- 创建：`packages/server/src/http/routes/environment.ts`
- 创建：`packages/server/src/http/routes/environment.test.ts`
- 修改：`packages/server/src/http/server.ts`
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/client/src/transport/__test__/http-client.test.ts`
- 修改：`packages/client/src/index.ts`

- [ ] **步骤 1：编写失败的协议和路由测试**

协议：

```ts
export interface EnvironmentTransitionSnapshot {
  transitionId?: string
  phase: "idle" | "draining" | "switching" | "ready" | "unavailable"
  currentKind: "local" | "docker" | "unavailable"
  targetKind?: "local" | "docker"
  blockers: Array<{
    ownerId: string
    kind: "agent" | "terminal" | "background"
    consumerId: string
  }>
  error?: string
  updatedAt?: number
}
```

测试 `GET /environment`、`POST /environment/switch`，拒绝未知字段、非法 environment、重复活动 transition 和客户端提供的 owner/config hash。

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @openharness/protocol test
pnpm --filter @openharness/client test -- http-client.test.ts
pnpm --filter @openharness/server test -- environment.test.ts
```

预期：FAIL，协议和路由尚不存在。

- [ ] **步骤 3：实现窄协议入口**

`POST /environment/switch` 只接受：

```json
{ "environment": "local", "drainTimeoutMs": 5000 }
```

或：

```json
{ "environment": "docker", "drainTimeoutMs": 5000 }
```

服务端生成受管 sandbox patch，拒绝 SRT、extraMounts、privileged、Docker Socket 和任意 cwd。响应：ready 返回 200；blocker 返回 409 并携带 snapshot；设置提交后失败返回 503 并携带 unavailable snapshot。Client 新增 `getEnvironmentTransition()` 与 `switchAgentEnvironment()`，不复用宽泛 `patchSettings()`。

- [ ] **步骤 4：运行 Protocol、Client、Server 测试和类型检查**

```bash
pnpm --filter @openharness/protocol test
pnpm --filter @openharness/client test
pnpm --filter @openharness/server test -- environment.test.ts routes.test.ts http.test.ts
pnpm --filter @openharness/server check-types
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/protocol packages/client packages/server/src/http
git commit -m "feat(protocol): expose environment switch status (task 11/13)"
```

## 任务 12：让 Desktop 设置页显示真实热切换状态

**文件：**

- 修改：`apps/desktop/src/shared/settings-types.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 修改：`apps/desktop/src/main/features/settings/ipc.ts`
- 修改：`apps/desktop/src/main/features/settings/settings-service.ts`
- 修改：`apps/desktop/src/main/features/settings/settings-service.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/environment-switch-model.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/environment-switch-model.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-control.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-model.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-control.test.tsx`

- [ ] **步骤 1：编写失败的 Desktop 服务与状态模型测试**

覆盖：

- snapshot 从 daemon 读取真实 current/target/phase，不再每次默认 `restartRequired=false`；
- 用户选择 Docker 后调用 `switchAgentEnvironment`，不再调用 `patchSettings({sandbox})`；
- draining/switching 时禁用选择器并显示“正在等待当前任务结束”或“正在切换运行环境”；
- 409 blocker 按“终端 2 个、后台任务 1 个”显示，并保持原选择；
- unavailable 显示 daemon 原始可操作错误，不显示已经切到 Docker；
- ready 后通过 settings changed IPC 更新设置页和终端面板；下一次新建终端立即使用新环境，无需重启应用。

```ts
expect(environmentSwitchNotice({
  phase: "draining",
  blockers: [
    { ownerId: "o1", kind: "terminal", consumerId: "t1" },
    { ownerId: "o1", kind: "background", consumerId: "j1" },
  ],
})).toContain("请先关闭 1 个终端并停止 1 个后台任务")
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --dir apps/desktop exec vitest run \
  src/main/features/settings/settings-service.test.ts \
  src/renderer/src/components/desktop/settings-page/environment-switch-model.test.ts \
  src/renderer/src/components/desktop/settings-page/runtime-setting-control.test.tsx
```

预期：FAIL，Desktop 仍返回 `restartRequired: true` 并调用 patchSettings。

- [ ] **步骤 3：实现 UI 和 IPC**

`DesktopSettingsSnapshot` 改为：

```ts
interface DesktopSettingsSnapshot {
  agentEnvironment: "local" | "docker" | "unsupported_srt"
  environmentTransition: EnvironmentTransitionSnapshot
  // 其他现有字段保持不变
}
```

删除 `restartRequired`。选择器提交期间显示本地 switching；服务响应后以 daemon snapshot 为准。主进程在 switch 成功或进入 unavailable 后广播权威 snapshot，Renderer 的设置控件和 `TerminalTool` 订阅同一事件；`TerminalTool` 在每次 create 前仍重新读取 snapshot，防止漏事件后使用旧环境。blocker 不提供“强制停止全部”按钮，本计划不授权设置页杀掉用户终端或后台任务。`unsupported_srt` 继续只显示错误，不自动转为本机。

- [ ] **步骤 4：运行 Desktop 测试、typecheck 和定向 lint**

```bash
pnpm --dir apps/desktop test
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop exec eslint \
  src/main/features/settings \
  src/shared/settings-types.ts \
  src/shared/ipc-channels.ts \
  src/shared/desktop-api-contract.ts \
  src/preload/desktop-api.ts \
  src/main/features/settings/ipc.ts \
  src/renderer/src/components/desktop/settings-page/runtime-setting-control.tsx \
  src/renderer/src/components/desktop/settings-page/runtime-setting-model.ts \
  src/renderer/src/components/desktop/settings-page/environment-switch-model.ts \
  src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx \
  --quiet --no-cache
```

预期：测试和 typecheck 全部通过，定向 lint 无 error。仓库其他既有 lint error 不在本任务内批量修改。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): switch Agent environments without restart (task 12/13)"
```

## 任务 13：真实 Docker 恢复 E2E、CI 与文档收尾

**文件：**

- 创建：`packages/server/e2e/environment-switch.e2e.test.ts`
- 修改：`packages/server/package.json`
- 修改：`.github/workflows/ci.yml`
- 修改：`docs/sandbox-runtime-flow.md`
- 修改：`docs/superpowers/specs/2026-09-07-agent-runtime-environment-and-terminal-design.md`

- [ ] **步骤 1：编写真实 Docker E2E**

E2E 使用唯一 container prefix 和临时配置目录，覆盖：

1. Docker Agent、Agent Terminal 和 background lease 共享一个 container；
2. 有 terminal/background blocker 时切换返回 409，旧环境继续可用且设置未变；
3. 关闭 blocker 后 Docker→local 切换完成，新 Agent 命令在宿主运行，旧临时容器消失；
4. local→Docker 后新容器 label 含 installation/workspace owner/config hash；
5. 模拟旧 daemon generation 留下临时容器和复用容器 exec，重开 application 后只删除临时 orphan、只杀复用容器旧 exec；
6. 篡改 installation label 的同名容器保持不动，目标 owner 返回 unavailable；
7. 测试结束断言唯一 prefix 下没有临时容器残留。

测试必须在 `afterEach` 用精确 prefix 清理自己创建的容器；不得扫描或删除其他 OHS 容器。

- [ ] **步骤 2：运行 E2E 并确认失败**

```bash
pnpm --filter @openharness/server e2e:environment
```

预期：FAIL，脚本和 E2E 文件尚未接线。

- [ ] **步骤 3：接入 Ubuntu Docker CI**

`ci.yml` 增加独立 `docker-environment-e2e` job：Ubuntu runner、Node 24、pnpm、冻结安装，先执行 `docker info`，再运行：

```bash
pnpm --filter @openharness/sandbox e2e:docker
pnpm --filter @openharness/tools e2e:docker
pnpm --filter @openharness/terminal-node e2e:docker
pnpm --filter @openharness/server e2e:environment
```

GitHub 托管 Windows/macOS 不假设存在可用的 Linux Docker daemon；本计划不添加会永久排队的 self-hosted job。跨平台真实 runner 编排由 3D 单独计划处理，3A 的 CI 证据是 Ubuntu Docker job，Windows 本机证据继续由开发验证记录提供。

- [ ] **步骤 4：更新权威文档**

文档必须写清：

- 热切换的提交点在 settings 原子保存；
- blocker 不会被静默杀掉；
- unavailable 不回退旧环境或宿主；
- installation ID 与 daemon generation 的区别；
- 复用容器可跨 daemon 保留，但旧 generation exec 会清理；
- 第三阶段 3B–3D 仍未完成，不提前勾选 Native Plugin、工作区清理或全平台 CI。

- [ ] **步骤 5：运行最终稳定验证**

Windows 上限制并发：

```bash
pnpm exec turbo test --concurrency=4 --env-mode=loose
pnpm exec turbo check-types --concurrency=4 --env-mode=loose
node --test scripts/prepare-tag-release.test.mjs scripts/npm-release.test.mjs
pnpm --filter @openharness/sandbox e2e:docker
pnpm --filter @openharness/terminal-node e2e:docker
pnpm --filter @openharness/server e2e:environment
git diff --check
```

若 Desktop 路由测试在全仓并发下超过默认 hook timeout，先单独运行完整 Desktop 包确认；只有确认是资源竞争且现有显式 timeout 不足时才调整测试 timeout，不能把产品失败标成 flaky。

- [ ] **步骤 6：确认安全不变量**

逐项核对：

- 切换开始后所有新 environment acquire 都失败；
- 设置提交前失败可以恢复旧环境 admission；
- 设置提交后失败只能 unavailable；
- 每个 owner 同时最多一个容器；
- 未验证 installation 的容器和 exec 没有收到删除/kill；
- 当前 daemon generation 的 exec 没有被 orphan reconciler 清理；
- terminal/background blocker 未被设置更新静默终止；
- 显式本机终端不阻塞环境切换；
- daemon 重启根据 source/target hash 做确定性恢复；
- 持久记录不包含旧 Settings 快照或 Session 环境版本。

- [ ] **步骤 7：Commit**

```bash
git add packages/server/e2e packages/server/package.json .github/workflows/ci.yml docs
git commit -m "test(runtime): verify environment lifecycle recovery (task 13/13)"
```

## 第三阶段 3A 完成条件

- Desktop 切换 local/docker 不再要求重启应用。
- 活跃 run 会先排空；用户终端和后台任务作为明确 blocker，不被静默终止。
- source 设置提交前可安全取消，target 设置提交后失败只进入 unavailable。
- daemon 重启可以根据持久 source/target hash 继续或确定性终止切换。
- 容器与 exec 带可验证 installation、daemon generation、environment 和 workspace owner 身份。
- 只清理当前 installation 的旧 generation orphan；未知所有权资源保持不动。
- 同一 owner 不存在多配置容器并存。
- 全仓单元/集成测试、类型检查、真实 Docker lifecycle E2E 和 Ubuntu Docker CI 全部有明确证据。
