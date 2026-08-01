# @openharness/services

共享服务：daemon `SessionStore`、print/REPL snapshot functions、CronScheduler、LspClient、OAuthFlow、CompactService。

## 功能

- **CronScheduler**: 定时任务调度
- **SessionStore**: daemon 权威 session/input/message/part/event/run/permission 持久化
- **session snapshot functions**: print/REPL 项目级快照与 transcript 导出；不供 TUI/daemon 使用
- **LspClient**: 代码智能服务 (stub)
- **OAuthFlow**: OAuth 流程 (stub)
- **CompactService**: 双层压缩

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
