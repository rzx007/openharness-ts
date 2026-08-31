# Prompt 分层与动态 Context

> 状态：当前实现。Prompt 只保留一个身份文件 `SOUL.md`；用户偏好、机器事实和项目长期信息统一来自 Context Persistence。旧 `USER.md` 与 local rules 不再加载。

## 为什么要分层

不同信息的变化频率和可信边界不同。把它们拼成一个长期大 prompt 会导致缓存失效、过期信息残留和权限边界不清。OpenHarness 将模型输入分为 stable、context、volatile 和 compact-only 四类。

```text
stable
  Agent identity（SOUL.md 或默认身份）
  framework invariants

context
  Environment
  Permission mode
  Work style
  Delegation guidance
  Custom instructions

volatile（每次真实模型请求重新生成）
  Project Instructions
  Governed Context bundle

compact-only
  Session Continuity checkpoint
  attachment catalog / task focus 等 compact 附件
```

## Stable：身份和框架不变量

`SOUL.md` 是 Agent 身份槽，只描述“Agent 是谁、怎样思考和协作”。它不保存用户偏好、项目规则、机器地址或会话进度。

- 缺少 `SOUL.md` 时使用默认身份。
- 内容在进入 prompt 前经过大小限制和注入风险扫描。
- 普通 Context 工具不能修改 `SOUL.md`。
- 身份初始化只创建缺失模板，不覆盖已有文件。

框架不变量由代码提供，包含权限、工具使用和安全边界。用户文件不能覆盖更高优先级规则。

## Context：本次运行环境

这一层描述当前运行条件，例如操作系统、工作目录、日期、权限模式、工作风格和用户显式传入的 custom prompt。它不承担长期记忆。

Project Instructions 来自项目内受支持的说明文件，表示仓库所有者明确维护的项目指导。它们和长期 Context 不同：前者是项目文件的一部分，后者由 Context 管理服务按语义条目维护。

## Volatile：受管长期 Context

每次物理模型请求前，QueryEngine 调用 `ContextRetriever`：

1. 根据当前 Session 得到 user、machine 和 project 逻辑作用域。
2. 从 Context store 读取 active 条目。
3. 应用项目覆盖、相关性选择和预算限制。
4. 渲染为瞬态 `system-reminder`。
5. 发给模型，但不写回常驻 system prompt 或消息历史。

检索发生在每次模型请求前，而不是只在创建 Agent 时发生。一次 Agent turn 中若模型调用工具并继续请求，Context 也会再次刷新。因此管理页修改、候选接受或忘记都可以被热 Agent 立即观察到。

候选不会注入。项目知识按当前输入筛选；用户偏好、机器事实和项目规则按作用域与语义键合并。最终内容受 `context.promptMaxChars` 和 `context.promptMaxEntries` 限制。

## Compact-only：会话连续性

Session Continuity checkpoint 不属于常规 system prompt。它只在 compact/autocompact 时通过 attachments provider 进入摘要 prompt，帮助摘要保留当前目标、下一步和最近进展。

这样可以同时满足：

- 普通请求不会反复携带整份会话 checkpoint。
- `/compact` 后不丢当前任务。
- 长期偏好和当前任务状态不会互相污染。

## 更新边界

| 信息 | 正确入口 | 不允许的入口 |
|---|---|---|
| Agent 身份 | 身份配置服务 / `SOUL.md` 初始化 | ContextRemember、普通文件工具 |
| 用户偏好 | Context 语义工具、API、管理页 | `USER.md` |
| 本机环境事实 | Context 自动提取或人工确认 | local rules 文件 |
| 项目规则/知识 | Context 语义工具、API、管理页；或项目自有 Instructions | 旧 Project Memory |
| 当前任务状态 | Session Continuity 自动维护 | 长期 Context 管理页 |
| 凭据 | credential/provider 专用存储 | 任意 prompt 或 Context |

## 安全与诊断

- `SOUL.md` 加载状态由身份诊断显示，不和 Context 条目混合。
- `/context preview <问题>` 显示当前问题将得到的逻辑 Context，不显示路径。
- secret 在写入前拒绝；敏感事实需要确认。
- 普通文件工具受到 managed resource policy 约束，不能修改 Context 状态或 `SOUL.md`。
- 即使机器上仍有旧 `USER.md`、local rules 或 Project Memory，Prompt 也不会读取它们。

## 验收要点

- 没有 `SOUL.md` 时仍使用完整默认身份和框架不变量。
- 有安全 `SOUL.md` 时只替换 identity slot。
- 高风险 `SOUL.md` 被阻断。
- Context 更新后，下一次模型请求看到新条目，无需重建 Agent。
- 候选和被忘记条目不进入 prompt。
- Project Context 不会泄漏到另一个项目。
- Context 注入不进入 durable transcript。
- compact summary 能读到 Session Continuity checkpoint，但普通请求看不到它。

相关文档：

- [Context 总图](./context-memory-map.md)
- [Context Persistence 生命周期](./memory-system.md)
- [Compact Service](./compact-service-design.md)
