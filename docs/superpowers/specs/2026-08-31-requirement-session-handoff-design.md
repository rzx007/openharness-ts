# 需求 Session 交接设计

> 状态：已确认设计。本文定义如何把来源 Session 中发散出的独立需求整理成 Markdown 交接单，创建同一项目中的另一个普通 Session，并立即在后台执行。

## 1. 背景与目标

一个 Session 可能正在讨论主需求 A，过程中又出现适合独立处理的需求 B。用户希望把需求 B 交给另一个 Session，继续在来源 Session 中处理主需求：

```text
Session A：讨论主需求
   │
   ├─ 讨论过程中出现独立需求 B
   │
   └─ 生成聚焦需求 B 的 Markdown 交接单
          │
          └─ 创建并立即运行 Session B
                 ├─ 带上必要背景
                 ├─ 带上已经确定的约束
                 ├─ 带上相关代码和资料
                 ├─ 带上待解决问题
                 └─ 只处理需求 B
```

本功能解决的是“需求拆分交接”，不是运行态迁移。Session B 不接管 Session A 正在运行的模型请求、Shell、Terminal、子 Agent、Workflow 或 Git 工作区。

## 2. 核心决策

1. 交接内容只有一份固定格式的 Markdown，不复制来源 Session 的原始消息。
2. 当前 Agent 根据已有对话生成交接单，不额外启动一次服务端总结模型。
3. Session B 是同一项目中的普通独立根 Session，不设置 `parentId`。
4. 交接关系只放在普通 metadata 中，不参与 Session 层级、权限、Job 路由、递归删除或生命周期。
5. Session B 创建后立即把交接单作为首条用户输入提交，并进入现有 Run 队列。
6. 用户默认留在 Session A；Session B 在后台运行。
7. Session B 完成、失败或中断后，不向 Session A 自动回传结果。
8. Agent 可以建议拆分，但只有用户同意后才能创建；用户直接要求拆分时不再二次确认。
9. “需求交接”和现有“创建会话分支”是两个不同操作。会话分支复制历史，需求交接只传递交接单。

## 3. 范围

### 3.1 第一版包含

- Agent Tool `SessionHandoff`。
- 手动自然语言触发。
- Agent 自动识别独立需求并提出建议。
- 固定 Markdown 交接单格式。
- 已有制品按路径或 URL 引用，不重复内容。
- 敏感信息清理要求和明显凭据检测。
- 同项目独立 Session 的原子创建。
- 首条 Input 和初始 queued Run 的原子持久化。
- 幂等重试。
- Session A 中的交接结果卡和导航入口。
- Session B 中的来源导航。
- Desktop、客户端、服务端和 Store 测试。

### 3.2 第一版不包含

- 复制 Session A 的消息或让用户选择原始消息。
- 交接单预览、编辑或二次确认窗口。
- 使用 `parentId` 或建立 Session 树。
- 运行中的模型请求、Terminal、Workflow、子 Agent 或 Git 工作区迁移。
- Session B 结果摘要回传 Session A。
- 临时目录中的 handoff 文件。
- 服务端第二次模型总结调用。
- 独立后台需求分类器。
- child Agent 创建项目级 handoff Session。
- 远程或云端 Session 迁移。

## 4. 用户交互

### 4.1 手动触发

用户可以在 Session A 中直接说：

```text
把附件 OCR 单独拆出去。
```

这句话本身就是授权。当前 Agent 应当：

1. 以“附件 OCR”为交接焦点；
2. 从当前对话中提取理解需求 B 所需的信息；
3. 生成固定格式的 Markdown 交接单；
4. 调用 `SessionHandoff`；
5. 不再询问是否创建，也不展示交接单预览。

### 4.2 Agent 自动探测

当 Agent 判断讨论已经出现相对独立的需求 B 时，可以用普通回复提出建议：

```text
附件 OCR 已经形成一项相对独立的需求。要把它交接到新的 Session 单独处理吗？
```

此时不得调用 `SessionHandoff`。只有用户明确同意后，Agent 才生成交接单并调用工具。

若用户拒绝、忽略建议或继续讨论，系统不创建 Session。

### 4.3 创建后的界面行为

交接成功后：

- Desktop 继续停留在 Session A；
- Session B 出现在同一项目的普通 Session 列表中；
- Session B 不出现在 child Agent 列表，也不显示成 Session A 的树形子节点；
- Session A 的工具结果位置显示交接卡；
- 用户点击“打开会话”后才切换到 Session B。

交接卡示意：

```text
┌─────────────────────────────────────┐
│ 已交接到新会话                      │
│                                     │
│ 附件 OCR                            │
│ 状态：正在处理                      │
│                                     │
│                         [打开会话]  │
└─────────────────────────────────────┘
```

卡片可以显示 Session B 的普通运行状态，但不显示结果摘要：

| Session B 状态 | 卡片文案 |
| --- | --- |
| `queued` / `running` | 正在处理 |
| `completed` | 已完成 |
| `failed` | 执行失败 |
| `interrupted` | 已中断 |

Session B 完成后不向 Session A 添加消息、不自动唤醒 Session A，也不提供“带回主会话”操作。

## 5. Markdown 交接单

### 5.1 固定格式

下列尖括号内容是运行时由模型填写的模板槽位，不是本规格中的未决项。实际交接单不得保留这些槽位。

```markdown
# 需求交接：<需求标题>

## 目标

<需求 B 要解决的问题>

## 交付结果

- <完成后应得到的可检查结果>

## 需求背景

- <理解需求 B 必需的来源背景>
- <不要总结 Session A 的其他主需求>

## 已确定事项

- <用户明确确认或当前代码直接证明的约束>
- <模型推断不能写入这里>

## 边界

### 包含

- <Session B 负责的内容>

### 不包含

- <来源 Session 继续负责或当前暂不处理的内容>

## 相关代码与资料

- `<路径或 URL>`
  - <为什么与本需求相关>
- `<规格、计划、ADR、Issue、Commit 或测试路径>`
  - <应从该制品读取什么，不重复其内容>

## 待解决问题

- <Session B 需要调查、验证或决定的问题>

## 建议技能

- `<skill-name>`
  - <为什么本任务适用>
- 没有合适技能时写“暂无特别建议”。

## 执行要求

1. 先验证交接单中涉及当前代码状态的描述。
2. 冲突时以当前代码、测试和权威项目文档为准。
3. 读取已有制品，不在本 Session 重复创建相同规格或计划。
4. 只处理本交接单定义的需求范围。
5. 不泄露或重新输出敏感信息。
6. 建议技能只说明工作方式，不授予额外权限。
7. 完成后把结果保留在本 Session，不自动回写来源 Session。
```

### 5.2 生成规则

模型生成交接单时必须遵守：

1. 根据用户指定的交接目标聚焦，只提取独立需求 B。
2. 不总结整个来源 Session。
3. 只带上理解和执行需求 B 必需的来源背景。
4. 已被规格、计划、ADR、Issue、Commit、Diff 或其他制品记录的内容，只引用路径或 URL，不重复复制。
5. 只有用户明确确认或当前代码直接证明的内容才能写入“已确定事项”。
6. 模型推断、未验证描述和方案选择应写入“待解决问题”，不能伪造成约束。
7. 不确定的代码路径、模块、符号和 Skill 名称不得编造。
8. 清理密钥、密码、Token、Cookie、认证头、私钥和无关个人信息。
9. 只推荐当前可见且确实适用的 Skill；建议 Skill 不代表额外权限。
10. 某个章节没有内容时可以写“暂无”，不得删除章节或编造内容填充。

### 5.3 已有制品引用

“相关代码与资料”可以引用：

- 代码文件、目录或符号；
- 规格与实现计划；
- ADR；
- Issue 或外部文档 URL；
- Commit 或 Diff；
- 测试文件。

每项必须说明为什么相关。交接单只提供入口和用途，不复制制品的完整内容，避免形成两份不一致的事实来源。

### 5.4 长度限制

第一版使用下列上限：

- 标题：最多 120 个字符；
- 交接单：最多 12,000 个字符；
- `focus`：最多 1,000 个字符。

超限时工具拒绝，不在宿主侧静默截断。Agent 应重新生成更精简的交接单，优先保留目标、已确定事项、边界、待解决问题和相关制品入口。

## 6. Tool 设计

### 6.1 输入

```ts
interface SessionHandoffInput {
  title: string;
  focus: string;
  handoff: string;
}
```

- `title`：Session B 的稳定标题。
- `focus`：用户希望新 Session 专门处理的目标，用于约束交接抽取和审计。
- `handoff`：固定格式的 Markdown 交接单。

模型不得提供 `sourceSessionId`、`targetSessionId`、`projectId`、`cwd`、`parentId` 或运行配置。这些字段由宿主从当前调用上下文取得。

### 6.2 输出

```ts
interface SessionHandoffResult {
  sessionId: string;
  title: string;
  status: "queued";
}
```

工具返回目标 Session ID，供 Session A 渲染导航卡。工具不等待 Session B 完成，也不返回 Session B 的执行结果。

### 6.3 可用范围

第一版只给普通根 Session 注册 `SessionHandoff`。child Agent 不注册该工具，避免执行内部子任务的 Agent 创建项目级独立 Session。

当前 Agent 已拥有来源对话上下文，因此由当前 Agent 生成 Markdown。服务端不再调用一次总结模型。

## 7. Session B 创建语义

### 7.1 独立根 Session

Session B 的配置来源于 Session A：

```ts
createSession({
  projectId: source.projectId,
  cwd: source.cwd,
  model: source.model,
  agent: source.agent,
  metadata: {
    ...inheritedRuntimeMetadata,
    handoff: {
      version: 1,
      kind: "requirement",
      sourceSessionId: source.id,
      focus: input.focus,
      createdAt,
    },
  },
});
```

不得设置 `parentId`。在当前系统中，`parentId` 表达 child session 或会话分支的父子语义，会影响列表过滤、Permission、Job 路由、递归删除和生命周期，不适合需求交接。

### 7.2 继承与不继承

继承：

- `projectId`；
- `cwd`；
- model 和 Provider/API 格式；
- Agent 配置；
- reasoning effort；
- permission mode；
- sandbox、插件开关和其他稳定 runtime metadata；
- Session mode。

不继承：

- Session A 的消息、Input、Run、Attempt 和 Task；
- Pending Permission；
- Prompt Queue；
- 子 Agent；
- Terminal；
- Session Memory checkpoint；
- UI 草稿；
- `parentId`；
- Session A 的标题、归档状态和临时运行状态。

Project Memory 不需要复制。Session A 和 Session B 使用相同项目目录，Session B 通过现有相关性检索自然获得项目级记忆。

### 7.3 来源 metadata

`metadata.handoff` 只用于：

- Session B 显示来源；
- 调试和审计；
- 从 Session B 打开来源 Session；
- 后续版本识别交接 Session。

它不参与：

- Session 层级；
- 权限继承；
- Job 或 child Agent 路由；
- 递归删除；
- 生命周期管理；
- 自动结果回传。

来源 Session 被删除或归档不影响 Session B。客户端找不到来源时隐藏来源入口或显示来源已不存在。

## 8. 原子创建与运行

“创建 Session B”“写入第一条 Input”“创建初始 Run”是一个应用命令和一个数据库事务：

```text
校验来源 Session 和交接单
        │
        ▼
事务开始
        ├─ 创建独立 Session B
        ├─ 写入 handoff metadata
        ├─ 写入 Markdown 首条 Input
        ├─ 投影首条用户消息
        └─ 创建 queued Run
        │
        ▼
事务提交
        │
        ├─ 发布 Session/Input/Run 事件
        └─ 将 Run 交给现有单 Session Run Lane
```

事务必须满足：

```text
要么 Session、Input、用户消息和 Run 全部存在；
要么它们全部不存在。
```

模型执行不属于数据库事务。提交之后 Session B 才开始普通 Run。若 daemon 在提交后、执行前重启，权威状态仍在 SessionStore 中，由现有 Run 恢复规则收束。

## 9. 幂等性

幂等键使用：

```text
sourceSessionId + toolUseId
```

相同工具调用因为网络断开、客户端重连、事件重放或 daemon 重启再次提交时：

- 返回第一次创建的 Session B；
- 不创建新的 Session；
- 不重复写入交接单；
- 不重复创建或启动 Run。

不同 `toolUseId` 即使标题和 Markdown 完全相同，也表示两次明确交接，可以创建两个 Session。系统不根据内容做隐式去重。

## 10. 校验、安全与错误处理

### 10.1 确定性校验

宿主校验：

- `title`、`focus`、`handoff` 非空且未超限；
- 一级标题符合 `# 需求交接：<标题>`；
- 九个必要章节存在且顺序正确；
- “边界”包含“包含”和“不包含”两个子章节；
- 明显凭据格式未出现。

宿主不自动重写或截断 Markdown。格式不合格时返回缺失章节，Agent 修正后重试。

### 10.2 敏感信息

模型负责语义层面的敏感信息清理。宿主额外检查明显高风险格式，例如：

- `Authorization: Bearer ...`；
- PEM 私钥头；
- 已知 API Key 前缀；
- 明显的密码、Token 或 Cookie 赋值。

命中时拒绝交接，不把命中的值写入工具错误、日志或事件。错误只说明交接单包含疑似敏感信息。

### 10.3 稳定错误码

```ts
type SessionHandoffErrorCode =
  | "invalid_handoff_title"
  | "invalid_handoff_format"
  | "handoff_too_large"
  | "sensitive_handoff_content"
  | "source_session_unavailable"
  | "handoff_admission_failed";
```

### 10.4 创建失败

Session、Input、消息或 Run 任一步失败，事务全部回滚，不在 Sidebar 留下空 Session。

数据库提交成功但 SSE 发布失败时，不删除已提交的 Session B。客户端重新拉取或工具用同一幂等键重试后会收敛到权威状态。

### 10.5 Session B 执行失败

Session B 执行失败不回滚交接，因为 Session、交接单和 Run 已经可靠创建。失败按普通 Run 处理：

- 在 Session B 中展示；
- 允许在 Session B 中按现有机制重试；
- Session A 的卡片可以显示“执行失败”；
- 不向 Session A 写入结果或错误摘要。

## 11. 组件边界

### 11.1 Tool 层

负责：

- 暴露 `SessionHandoff` Schema 和模型说明；
- 从工具运行上下文取得稳定 `toolUseId`；
- 调用宿主提供的交接能力；
- 返回目标 Session ID 和 queued 状态。

不负责数据库事务、Session 配置继承或运行调度。

### 11.2 Application 层

负责：

- 校验来源 Session；
- 读取和过滤可继承的运行配置；
- 校验 Markdown；
- 建立幂等请求；
- 调用 Store 原子创建；
- 提交后发布事件并唤醒 Run Lane。

### 11.3 SessionStore

负责：

- 在单一事务中创建独立 Session、Input、消息和 Run；
- 保存 handoff metadata 和幂等记录；
- 保证回滚和重启后的权威状态。

Store 不理解 Agent 的自然语言意图，也不生成 Markdown。

### 11.4 Client/Desktop

负责：

- 渲染工具结果卡；
- 根据目标 Session ID 查询状态；
- 保持 Session A 的导航所有权；
- 把 Session B 放进普通项目 Session 列表；
- 提供来源和目标 Session 的导航入口。

客户端不维护第二份交接状态。刷新和重启后从 SessionStore 快照和事件恢复。

## 12. 测试设计

### 12.1 Markdown 校验单元测试

- 合法九段 Markdown 通过；
- 标题、章节、子章节缺失或顺序错误时拒绝；
- 空章节使用“暂无”时通过；
- 标题、focus 和正文超限时拒绝；
- 普通代码块、路径和 URL 不误判；
- Bearer Token、私钥和已知密钥格式被拒绝；
- 敏感信息错误不重复输出命中的值。

### 12.2 Store 原子性测试

成功时断言：

- Session B 没有 `parentId`；
- project、cwd、model、Agent 和允许的 runtime metadata 正确继承；
- handoff metadata 指向 Session A；
- Session A 的历史未复制；
- Session B 只有交接单产生的首条 Input 和用户消息；
- 初始 Run 引用该 Input 且状态为 queued；
- Session A 未被修改。

分别让 Session、Input、消息或 Run 写入失败，每次都断言全部回滚。

### 12.3 幂等与恢复测试

- 同一请求串行重试只创建一个 Session；
- 同一请求并发重试只创建一个 Session；
- 提交成功但调用方未收到响应时重试返回原 Session；
- daemon 重启后重复请求仍返回原 Session；
- SSE 发布失败不触发第二次创建；
- 不同 toolUseId 可以创建不同 Session；
- 已提交 Run 使用现有重启恢复规则。

### 12.4 Tool 测试

- Tool 只接收 `title`、`focus`、`handoff`；
- 模型不能指定项目、路径、来源 ID、`parentId` 或运行配置；
- 缺少持久根 Session 上下文时工具不可用；
- child Agent 不注册 Tool；
- Tool 描述包含聚焦、引用制品、事实区分、脱敏、Skill 推荐和固定格式规则。

### 12.5 Agent 验收 Prompt

自动探测：

```text
我们继续做附件上传。另外以后可能需要 OCR，不过先把 OCR 单独作为一个需求考虑。
```

预期 Agent 可以建议拆分，但不得直接调用工具。用户回复“可以，拆出去”后才调用。

手动触发：

```text
把附件 OCR 单独拆出去。
```

预期不再二次确认，直接生成交接单并调用工具。

### 12.6 Desktop 测试

- 成功后 `activeSessionId` 仍是 Session A；
- Session B 加入普通项目 Session 列表；
- Session B 不进入 child Agent 列表；
- 点击卡片后才切换到 Session B；
- 并发交接响应不抢夺当前导航；
- Session A 归档或删除不影响 Session B；
- 来源不存在时来源入口安全隐藏；
- 重启客户端后卡片通过持久目标 Session ID 恢复状态；
- 卡片不展示结果摘要。

## 13. 完整验收标准

1. 在 Session A 中讨论主需求并引出需求 B。
2. Agent 可以建议拆分，但在用户同意前不创建 Session。
3. 用户同意后，Agent 生成符合固定格式的交接单。
4. `SessionHandoff` 创建同项目、同 cwd 的独立 Session B。
5. Session B 没有 `parentId`，也不包含 Session A 的原始消息。
6. Session B 的首条用户消息是 Markdown 交接单。
7. Session B 的初始 Run 已持久化并立即进入后台执行。
8. Desktop 仍停留在 Session A，并显示目标 Session 导航卡。
9. Session B 出现在普通 Session 列表，可以独立打开、归档和删除。
10. Session B 完成、失败或中断后不向 Session A 自动回写内容。
11. 删除或归档 Session A 不影响 Session B。
12. 重启 Desktop 和 daemon 后，Session、交接单、Run、幂等关系和导航状态可恢复。
13. 用户直接要求拆分时不出现确认步骤，直接完成创建和后台执行。

## 14. 与现有能力的关系

| 能力 | 是否复制历史 | 是否设置 `parentId` | 是否立即运行 | 用途 |
| --- | --- | --- | --- | --- |
| 继续原 Session | 使用原历史 | 不变 | 用户提交后运行 | 继续同一讨论 |
| 创建会话分支 | 复制选定历史 | 是 | 由后续输入决定 | 从旧讨论点分叉 |
| Agent child session | 由 Agent Runtime 管理 | 是 | 是 | 执行父 Agent 的内部子任务 |
| 需求交接 | 不复制，只传 Markdown | 否 | 是 | 把发散需求交给同项目独立 Session |

需求交接不得复用 child Agent 的父子生命周期，也不得把 `forkSessionWithHistory` 当作实现捷径。
