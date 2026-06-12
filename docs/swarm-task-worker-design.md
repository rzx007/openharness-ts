# 设计：Swarm 长驻 worker（重启式多轮 sendMessage）

> 状态：已批准。补 swarm 最后一块大缺口：teammate 多轮对话。

## 核心认知（读 Python 源后修正）

Python 的"长驻 worker"**不是常驻进程**，而是**重启式多轮**：

- `--task-worker` 模式的 worker 每次只读**一行** stdin → 跑一轮 → 退出
  （`ui/app.py run_task_worker`，显式注释 one-shot）；
- `send_message` = 往任务 stdin 写一行 JSON；任务已结束时由
  BackgroundTaskManager **懒复活重启**进程再写入；
- **重启不保留上下文**——TS TaskManager 已有同款提示文案
  （"prior interactive context was not preserved"）。

TS 底子已齐：`TaskManager.writeToTask` 懒复活（B.3）、`createAgentTask`
（prompt 经 stdin）、`type:"agent"` 任务标记、TaskWait。

## 三轮

### R1 — `--task-worker` CLI 模式

- `index.ts` 加 flag（内部用）；`main.ts` 加 `runTaskWorker(settings, options)`：
  - bootstrap 同 print（含 D.5 的 swarm worker permissionPrompt 文件流）；
  - `decodeTaskWorkerLine(raw)`：JSON 解析取 `text` 字段，非 JSON 按纯文本
    （对齐 Python `_decode_task_worker_line`）；
  - stdin readline 读一行 → `submitMessage` 流式 stdout → break → 退出；
  - 个性化/checkpoint 钩子照 print 模式挂。

### R2 — backend 改造

- `buildTeammateCommand`：argv 改 `--task-worker`（**prompt 不再进 argv**，
  经 stdin 喂——顺带消掉 prompt 过长撑爆 argv 的隐患）；
- `TaskRunner` 接口扩 `createAgentTask`（options 形态：argv+prompt+env+type）
  与 `writeToTask`；runtime 适配器透传 TaskManager 真实现；
- `SubprocessBackend.spawn` 改走 `createAgentTask`；
- `sendMessage(agentId, message)`：写 JSON 行
  `{text, from, timestamp, color?, summary?}`（替换现在的 throw）。

### R3 — E2E + 文档

- 真模型 E2E：spawn → TaskWait → SendMessage 续聊 → TaskWait 取第二轮结果
  （验证懒复活链路）；
- `swarm-subprocess-flow.md`：one-shot 注释更新为重启式多轮 + 上下文不保留
  说明；PLAN/README 同步。

## 与 Python 差异

| 点 | Python | TS | 原因 |
|----|--------|----|------|
| api-key | argv `--api-key` | 不进 argv（settings/env） | TS teammate 既有约定 |
| 上下文连续性 | 重启不保留（注释明示） | 同 | 对齐；将来可经 session 快照恢复（已有 E.6 存储，留待） |
| `system_prompt_mode`/`plan_mode_required` flags | 有 | 暂不传（TS spawn 配置无对应） | 字段缺口，留待 |
| 空行/纯空白 stdin | continue 继续等下一行 | 直接退出（懒复活会重投下一条） | 退出比无限等更稳健 |
| 无 text 的 JSON 对象 | 原始行当 prompt | 同（审查修复后对齐） | 防静默空转烧重启额度 |

## 测试

- decodeTaskWorkerLine：JSON 行取 text、坏 JSON 当纯文本、空行跳过；
- buildTeammateCommand：argv 含 --task-worker、不含 prompt；
- SubprocessBackend：spawn 走 createAgentTask（prompt 透传）、sendMessage
  写 JSON 行（fake runner 断言）、shutdown 清映射；
- E2E（手动）：两轮往返。
