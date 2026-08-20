# 第一批死代码清理设计

## 目标

只删除经入口、引用图和运行配置共同确认不可达的代码，收缩无意义的模块导出，并修复一个不改变行为的 frecency 常量漂移问题。

## 范围

- Runtime：把仅在文件内使用的 `serializeError` 攬回模块内部。
- TUI：删除无引用静态模型目录和未挂接的 diff 探针；清理 TypeScript 明确报告的无效导入/测试辅助符号；让 frecency 公式使用唯一的半衰期常量。
- Desktop：删除 Electron 模板组件、无引用兼容转发、无引用错误横幅、无引用菜单分隔组件、无引用 IPC 类型别名，以及没有 renderer 消费者的 `main-process-message` 模板事件链。

## 非目标

- 不处理 TUI Workflow、MCP、Todo、Swarm、Tasks 或 Bridge 的功能链路。
- 不处理 window、tray、pet 的无调用 IPC；这些入口的去留需要产品决定和手工冒烟验证。
- 不收缩 `code-block.tsx`，不统一 Desktop API 契约，不抽取 memory，不拆分 `agent.ts`。
- 不修改当前工作树中已有的 Desktop 在途文件。

## 验证

纯删除没有新的运行行为可用于构造有意义的失败测试，因此使用现有测试作为行为契约：编辑前确认基线，编辑后运行分域类型检查、测试和 Desktop lint，并用精确引用扫描确认已删除符号没有残留。frecency 保持“经过一个半衰期贡献约为 0.5”的现有行为断言。
