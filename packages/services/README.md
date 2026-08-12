# @openharness/services

共享服务：daemon `SessionStore`、print/REPL snapshot functions、Cron 时间调度、LspClient、CompactService。

## 功能

- **CronScheduler**: 只计算触发时间并调用传入的执行函数；任务和执行记录由 daemon `SessionStore` 保存
- **SessionStore**: daemon 权威 session/input/message/part/event/run/permission 持久化
- **session snapshot functions**: print/REPL 项目级快照与 transcript 导出；不供 TUI/daemon 使用
- **LspClient**: 代码智能服务 (stub；ripgrep 查询走统一 Sandbox argv 入口)
- **CompactService**: 双层压缩

外部工作负载进程不在 services 内直接 `spawn/exec`：`TaskManager`、autodream、Cron 和 LSP 查询统一委托 `@openharness/sandbox`。跨端 durable task 状态仍由 daemon `SessionStore` 投影负责。

## 使用

```ts
import { CompactService } from "@openharness/services";

const compactor = new CompactService();
await compactor.autoCompact(context);
```

## 测试

```bash
pnpm --filter @openharness/services test
```
