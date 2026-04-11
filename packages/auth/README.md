# @openharness/auth

API Key 认证管理。

## 功能

- API Key 验证和加载
- 认证状态检查

## 使用

```ts
import { loadApiKey, hasApiKey } from "@openharness/auth";

const key = loadApiKey();
const valid = hasApiKey();
```

## 测试

```bash
pnpm --filter @openharness/auth test
```