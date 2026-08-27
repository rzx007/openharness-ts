# 任务 7：store 组合与测试拆分报告

## 范围

- 基线：`f8faed6`
- 兼容入口 `desktop-session-store.ts` 现仅导出 store、事件挂接、helper、selector 和公开类型。
- 唯一 Zustand store 在 `desktop-session/store.ts` 组合初始 state 与五组 action creator。
- 原入口中残留的 snapshot/SSE 对账、持久化和项目 Git 刷新触发逻辑移到 `session-view-actions.ts`；组合文件不再直接实现业务 action。
- 未创建任务 8 的 `desktop-session/README.md`。
- 未触碰两份 conversation attachments 计划/设计附件。

## 旧测试拆分映射

旧 `desktop-session-store.test.ts` 的 38 条断言已删除并逐组迁移：

| 原职责 | 目标文件 | 迁移条数 |
| --- | --- | ---: |
| 兼容类型导出 | `desktop-session-store-compat.test.ts` | 1 |
| provider refresh、project order、bootstrap、Git cache | `desktop-session/project-actions.test.ts` | 14 |
| outside-project、创建/打开与 primary snapshot 生命周期 | `desktop-session/session-actions.test.ts` | 5 |
| send/edit/interrupt/permission、promote/cancel | `desktop-session/prompt-actions.test.ts` | 18 |

`store.integration.test.ts` 额外覆盖组合接口、快速连续发送、SSE 先确认而 IPC 失败、以及后台会话错误隔离。测试 fixture 通过 `resetDesktopSessionStore()` 在每个测试开始时恢复独立 state，避免复用 Zustand runtime 或全局 mock 的可变状态。

## 验证记录

在 `apps/desktop` 运行：

- `vitest run src/renderer/src/stores/desktop-session`：10 文件、96 测试全部通过（旧 store 基线为 38 条）。
- `vitest run`：38 文件、227 测试全部通过。
- `tsc --noEmit -p tsconfig.web.json --composite false --pretty false`：exit 0。
- `eslint src/renderer/src/stores/desktop-session src/renderer/src/stores/desktop-session-store.ts src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`：exit 0；保留 5 条既有纯状态文件的 Prettier 换行风格 warning，未将它们纳入任务 7 提交。
- `rg -n "desktop-session-store" apps/desktop/src/renderer/src/stores/desktop-session`：无反向兼容入口导入。
- `git diff --check`：通过。

## 后续边界

任务 8 仍需基于真实代码补写 `desktop-session/README.md`，并完成最终覆盖扫描、仓库级检查与审查。
