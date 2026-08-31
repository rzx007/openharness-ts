# Context Persistence 与会话连续性

> 状态：当前实现。文件名保留为 `memory-system.md` 以维持文档链接稳定；正文描述的是已经上线的统一 Context Persistence。旧 Memory/Personalization 运行时已删除，不做兼容读取。

## 目标

当用户说“记住”时，Agent 不应该自行寻找 `USER.md`、`rules.md`、`MEMORY.md` 或任何记忆目录。正确流程是：

```text
用户表达记忆意图
  → Resolver 拆分语义条目并判断作用域
  → Policy 检查置信度、敏感性和冲突
  → ContextPersistenceService 执行逻辑操作
  → MarkdownContextStore 原子写入受管主题文档
  → 下一次模型请求重新检索最新 Context
```

这套设计保留 Markdown 可读、可备份、可审查的优点，同时消除 Agent 猜路径、多个子系统抢写和一个规则一个文件的问题。

## 所有权边界

Context 是 `agent-runtime` 的原生能力，但不是由 runtime 自己持有的磁盘状态：

- daemon 拥有 `MarkdownContextStore` 实例，验证 session/cwd，并解析稳定的 user、machine、project scope。
- `ContextPersistenceService` 是唯一的管理操作入口，统一执行 remember、list/get、recall、update、forget 和 candidate resolve。
- `ContextResourceService` 只把 HTTP/Desktop 的 cwd 转成 runtime scope，再把服务结果映射成资源错误；它不接收 Store。
- daemon 注入的 `AgentContextMemoryHost` 只校验会话、解析 scope、委托服务和裁剪 Agent 可见字段；它不直接读写 Store，也不重复敏感度、冲突或 topic 规则。
- `agent-runtime` 负责条件注册 Context 工具和逐轮 Context 注入，不知道 Markdown 的位置。

`ContextQueryService` 是有意保留的独立只读路径：它专门为模型 Prompt 做相关性选择、作用域覆盖和预算渲染，不承担管理型查询或 mutation。

## 明确记住

用户明确要求记住且作用域清晰、置信度高、没有冲突时，系统立即保存。例如：

| 输入 | 结果 |
|---|---|
| `记住以后回答尽量简洁。` | 保存 user preference |
| `记住这个项目统一使用 pnpm。` | 保存 project rule |
| `记住我喜欢 pnpm。` | 语境不足，询问作用域/含义 |
| `记住 API key 是 sk-test-secret。` | 拒绝保存 |
| `把这个项目的包管理器改成 pnpm。` | 明确替换已有语义条目 |

一句话包含多件事时会先拆分再分别治理。某一条包含 secret 不会阻止其他安全条目保存：

```text
记住回答详细、注释中文、项目使用 pnpm。
  → user: 回答详细程度
  → user: 注释语言
  → project: 包管理器规则
```

系统不会为高置信度的直接保存额外制造确认步骤；只有不确定、敏感或冲突时才问。

## 主题式 Markdown

一个 Markdown 主题文档容纳多个 entry block。主题用于人类管理和批量备份，block 用于精确更新：

- 同一组 UI 设计规范只占一个 UI 主题文档。
- 每条配色、圆角、间距和阴影规则都有独立 ID。
- 更新一条规则不会覆盖相邻规则或文档中的人工说明。
- 严格解析 schema 2；缺字段、重复 ID、非法作用域或损坏 block 会报错，不猜旧格式。
- 写入使用临时文件、复读校验和原子 rename。
- 同一作用域的 mutation 串行执行，避免并发覆盖。

主题文档是服务内部实现。Agent、REST 响应、Slash 输出和 Desktop 管理页都只显示逻辑条目，不显示实际路径。

## 自动提取与候选

成功 root Run 的维护顺序是：

1. durable Run 已经进入 `completed`。
2. 写 Session Continuity checkpoint。
3. 如果 `context.enabled` 和 `context.automaticExtractionEnabled` 均开启，从 durable transcript 提取环境事实。
4. 同一个 policy 决定自动提交、进入候选或拒绝。

默认规则：

- 高置信度且非敏感的环境事实可以自动提交。
- 低一些置信度的环境事实进入候选。
- 项目知识和其他自动推断内容进入候选。
- 内部地址等敏感内容进入候选。
- secret 直接拒绝，不产生候选。
- failed/interrupted Run 不提取。

多个候选会聚合进同一作用域的待确认主题文档。接受候选时，服务先幂等写入目标主题，再从待确认主题移除；拒绝只删除候选。

## 冲突和更新

条目用 `semanticKey` 表示“它描述的是哪个槽位”。例如项目包管理器始终对应同一个语义键：

- 内容等价：返回 `noop`，不重复写入。
- 内容不同但用户没有表达替换：返回 conflict clarification。
- 用户明确说“改成”“改为”“替换为”：写入新 active 条目，并保留可审计的取代关系。
- API 编辑已知 ID：只更新目标 block。

项目作用域优先于相同语义键的 user 默认值，因此用户可以全局偏好 npm，同时某个项目明确要求 pnpm。

## 每轮查询

QueryEngine 不缓存长期 Context。每次真正调用模型前都会执行 Context retriever：

1. 读取当前 user、machine、project 的 active 条目。
2. 去除候选、禁用、已取代项。
3. 按语义键合并作用域覆盖。
4. 只选择和当前问题相关的项目知识。
5. 在 `promptMaxChars` 和 `promptMaxEntries` 预算内渲染。
6. 用临时 `system-reminder` 注入本次请求。

因此 Desktop 或另一个客户端刚修改的条目，热 Agent 下一次请求即可看到；Context 内容不会泄漏进 durable 消息历史。

## 受控整合 `/dream`

`/dream --preview` 只生成逻辑计划，不写盘。正式 `/dream`：

1. 读取 active 逻辑条目，不把路径交给 planner。
2. 只接受 `merge`、`update`、`disable` 操作和已知 entry ID。
3. 拒绝未知 ID、未知字段、敏感内容，以及任何 path/directory/root/file 字段。
4. 执行前备份受影响主题。
5. 所有写入仍通过 Context store；planner 不能直接编辑 Markdown。
6. 单项失败会生成明确 receipt，其他项可以继续并保留恢复备份。

## 忘记

忘记操作按稳定 entry ID 删除唯一 block。删除后：

- 下一次 Context 查询不再返回它。
- 相邻 block 和人工说明保持不变。
- 热 Agent 无需重启。
- 不会删除 Session transcript 或 Session Continuity checkpoint。

## Session Continuity 不是长期 Context

Session Continuity checkpoint 只解决 compact 后的当前任务连续性：

- Run 成功后自动写入当前目标、下一步、已验证工作、活跃产物和最近消息摘要。
- compact/autocompact 通过 attachments provider 读回。
- 只进入 compact summary prompt，不进入普通每轮 system prompt。
- 由 `sessionContinuity.enabled` 独立控制。

长期 Context 被删除，不代表应删除当前会话 checkpoint；反过来，compact checkpoint 也不会变成跨会话偏好。

## 配置

```json
{
  "context": {
    "enabled": true,
    "explicitCommitThreshold": 0.85,
    "automaticEnvironmentCommitThreshold": 0.95,
    "automaticExtractionEnabled": true,
    "candidateRetentionDays": 30,
    "promptMaxChars": 12000,
    "promptMaxEntries": 40
  },
  "sessionContinuity": {
    "enabled": true
  }
}
```

没有旧 `memory.*` key fallback。旧配置不会控制新系统。

## 管理与可观察性

- `/remember <内容>`：显式写入。
- `/context status`：active、candidate 和作用域/类型统计。
- `/context list`、`show`、`preview`：读取逻辑状态。
- `/context add`、`update`、`remove`：管理条目。
- `/context candidates`、`accept`、`reject`：管理候选。
- `/dream [--preview]`：整合。
- Desktop Context 页：图形化完成同一组操作。

所有结果都返回条目 ID、逻辑作用域、类型、主题和状态，不返回 Markdown 文件路径。

## 旧结构迁移边界

系统不会读取、迁移或删除旧 `USER.md`、local rules、Project Memory 或旧 `/memory` 数据。这样可以避免静默导入错误规则或敏感信息。若用户需要保留旧内容，应在审核后通过 `/remember` 或 Context 管理页重新录入。

相关文档：

- [Context、Prompt 与会话连续性总图](./context-memory-map.md)
- [Prompt 分层](./prompt-layering-design.md)
- [人工验收提示词](./runtime-acceptance-prompts.md)
