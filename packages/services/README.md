# @openharness/services

各种服务：CronScheduler、SessionStorage、LspClient、OAuthFlow、CompactService。

## 功能

- **CronScheduler**: 定时任务调度
- **SessionStorage**: 会话持久化
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