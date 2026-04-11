# @openharness/utils

Utility functions for path handling, JSON operations, and common operations.

## 功能

- 跨平台路径处理（resolve, join, normalize）
- JSON 序列化/反序列化
- 文件系统操作工具
- 环境变量处理

## 使用

```ts
import { resolvePath, readJson, writeJson } from "@openharness/utils";
```

## API

### 路径

- `resolvePath(...paths: string[])` - 跨平台路径解析
- `joinPath(...paths: string[])` - 路径拼接
- `normalizePath(path: string)` - 路径规范化

### JSON

- `readJson<T>(path: string)` - 读取 JSON 文件
- `writeJson(path: string, data: unknown)` - 写入 JSON 文件

### 环境

- `getEnv(key: string, default?: string)` - 获取环境变量

## 测试

```bash
pnpm --filter @openharness/utils test
```

## 依赖

- `@types/node`