# @openharness/bridge

Session 桥接管理，用于跨进程/网络通信。

## 功能

- Bridge 管理器 CRUD
- 连接状态追踪

## 使用

```ts
import { BridgeManager } from "@openharness/bridge";

const manager = new BridgeManager();
const bridges = manager.listBridges();
```

## 测试

```bash
pnpm --filter @openharness/bridge test
```