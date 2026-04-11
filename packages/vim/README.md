# @openharness/vim

Vim 模式引擎。

## 功能

- Normal 模式
- Insert 模式
- Visual 模式
- Operator-pending 模式
- 动作/文本对象

## 使用

```ts
import { VimEngine, VimMode } from "@openharness/vim";

const vim = new VimEngine();
```

## 测试

```bash
pnpm --filter @openharness/vim test
```