# 分离式执行运行时拆分

## 目标

从分离式执行链路中移除含糊的公共/内部 `Task` 术语，同时避免让人误以为 Terminal 或 Workflow 也由同一个运行时管理。

目标运行关系如下：

```text
Jobs
├─ TerminalJobAdapter -> TerminalRuntime
├─ DetachedExecutionJobAdapter
│  ├─ DetachedProcessSupervisor
│  ├─ ChildAgentExecutionRegistry
│  └─ SessionExecutionProjector -> SessionExecutionRecord
└─ WorkflowJobAdapter -> WorkflowRunner / WorkflowRunStore
```

模型侧用于创建后台 shell 的工具改名为 `BackgroundShellCreate`，不保留 `TaskCreate` 兼容别名。

## 职责边界

### DetachedProcessSupervisor

只管理在本机启动的非 PTY 进程执行：

- 创建 shell、argv、dream 和显式 Agent 子进程；
- 保存子进程句柄及其执行代次；
- 管理输出文件、stdin 串行写入、等待、停止和重启；
- 为后台进程执行提供生命周期监听器。

它不登记 framework child Agent 句柄，也不管理 Terminal 或 Workflow。

### ChildAgentExecutionRegistry

只管理由 Agent framework 驱动的 child Agent 执行句柄：

- 登记、开始和完成 child Agent 执行；
- 通过回调转发输入和停止请求；
- 保存输出快照并发布生命周期事件；
- 为已登记的 child Agent 执行提供等待能力。

它不启动操作系统进程，也不管理 Terminal 或 Workflow。

### SessionExecutionProjector

把两个运行时后端的状态投影到 session 持久执行记录。

持久记录包含明确的执行后端标记，因此 Jobs 在执行读取、发送输入和取消操作时，可以直接选择正确的后端，不需要再探测一个通用 Manager。

为了兼容现有数据，SQLite 表名继续保留；TypeScript 领域类型和 API 使用面向 execution 的命名。

## 迁移顺序

1. 先增加失败测试，证明两个运行时后端相互独立，并且任何一个后端都不暴露另一个后端的创建或登记 API。
2. 提取 `DetachedProcessSupervisor` 和 `ChildAgentExecutionRegistry`，增加按工作目录和 session 隔离的运行时注册表，并迁移 services 测试。
3. 把持久化 TypeScript 投影以及 bridge/service API 改为 session execution 术语，同时保留现有数据库表。
4. 迁移 daemon Jobs 路由、后台 shell HTTP、child Agent projector、Workflow、AutoDream 和本地 Jobs host。
5. 在工具注册表、Coordinator、提示词、测试和当前文档中，把 `TaskCreate` 硬切为 `BackgroundShellCreate`，不保留别名。
6. 审计旧的公共和内部符号，并运行受影响测试、全量测试以及工作区类型检查。

## 兼容性决策

- Jobs HTTP、client、tool 协议以及 Job ID 保持不变。
- Terminal runtime 和 Workflow runtime 不会被移动到分离式执行组件中，也不会由这些组件包裹。
- `/schedules/tasks` 和 Workflow plan 中的 `tasks` 属于各自领域，继续保留原有术语。
- 本次重构保留现有数据库表名，只修改 TypeScript 领域类型和 API 符号。
- 对于没有执行后端标记的旧持久记录，系统根据原有的 origin/type 元数据选择后端；所有新投影都会写入明确的后端标记。
