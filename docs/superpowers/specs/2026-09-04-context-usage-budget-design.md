# 上下文占用分桶与预算观测设计

日期：2026-09-04

状态：已确认，待用户审查书面规格后进入实现计划

## 结论

OpenHarness 在「下一跳请求组装完成」时生成只读的 `ContextUsageSnapshot`，按固定桶统计启发式 token，对照**当前 session 模型**的 `contextWindow` 计算占用百分比。桌面端提供与 Cursor Context 托盘同构的环 + 分段条 + 分类列表；CLI/HTTP 通过 `/context usage` 消费同一快照。本版只做观测与软提示，不拦截发送、不自动裁剪。

## 已确认决策

| 项 | 选择 |
| --- | --- |
| 交付面 | 桌面环/托盘 + 共享 API/CLI（`/context usage`） |
| 治理 | 观测 + 软提示，不硬拦截 |
| 分桶 | 对齐截图 7 类，另加独立 `Summarized conversation` |
| 估算 | v1 启发式 `ceil(chars/4)`；真实 tokenizer 后置 |
| 下钻 | v1 仅桶级；按 MCP/rule/skill 下钻后置 |
| 架构 | 组装点 Ledger（方案 1） |
| 换模 | 快照绑定当前 `runtime.model` 窗宽；立即重算百分比 |

## 目标

- 让用户看清「当前模型上下文窗」里各类内容各占多少 token。
- 同 session 切换模型时，分母与告警随新模型更新，避免误判。
- CLI、HTTP、桌面共用一份快照，避免两套分类逻辑。
- 用软提示引导 compact / 关注静态前缀膨胀，不改变发送路径。

## 非目标

- 硬拦截发送、自动裁剪、自动触发 compact。
- 桶内按 MCP server、rule 文件、skill 名下钻。
- 真实 tokenizer 或跨模型复用上一轮 provider `usage` 作为精确校准。
- 与 Workflow `budgetPolicy` 合并。
- 改写 Context Persistence 的写入/存储模型。
- 网页 frontend 完整复刻桌面托盘（非本版验收必选项）。

## 与现有能力的关系

- **复用**：`buildPromptLayers`、内置工具与 MCP 注册表、session messages、compact 摘要消息、`ModelInfo.contextWindow` / `outputLimit`、现有 `/context` preview 与 status。
- **正交**：Context Persistence（记住/规则持久化）负责写什么；本功能只计量「进窗内容」。
- **不合并**：Workflow 的 token/time `budgetPolicy` 是多 worker 调度预算，不进入本快照。
- **增量**：保留 `/context`、`/context status`；新增 usage 通道，不替换「来源状态表」。

## 架构

### 单元职责

| 单元 | 职责 | 不做 |
| --- | --- | --- |
| `ContextBudgetAssembler` | 对已组装的 prompt 段、工具 schema、消息打桶标签，估 token，汇总快照与 tips | 不调模型、不 compact、不改组装结果 |
| `ContextService.usage()` | 返回 `{ snapshot, report }`；驱动 `/context usage` 与 HTTP | 不发明第二套分桶 |
| Desktop context ring + tray | 对齐截图：百分比、总量、分段条、分类列表；换模刷新 | 不下钻、不做独立设置大页 |
| Soft tip | 按阈值生成提示文案 | 不阻止发送 |

### 推荐放置

- 分桶与估算纯逻辑：放在共享包内的纯模块（优先 `packages/services` 或 `packages/core`，与现有 `estimateTokens` 同层风格），无 UI/HTTP 依赖，便于单测。
- 数据采集与 `ContextService.usage()`：在 server/daemon 侧、能看到「最终 system / tools / messages」的边界调用 Assembler。
- 桌面与 CLI：只消费快照 / report，不在渲染层重算分桶。

## 数据模型

```ts
type ContextBucketId =
  | "system"
  | "tools"
  | "rules"
  | "skills"
  | "mcp"
  | "subagents"
  | "summary"
  | "conversation";

interface ContextUsageBucket {
  id: ContextBucketId;
  label: string;
  tokens: number;
}

interface ContextUsageTip {
  code: string;
  message: string;
}

interface ContextUsageSnapshot {
  model: string;
  contextWindow: number | null;
  outputLimit?: number | null;
  estimatedInputTokens: number;
  /** 相对当前 contextWindow；无窗宽时为 null。允许大于 1（换到更小窗且已溢出）。 */
  percentFull: number | null;
  estimator: "heuristic_v1";
  buckets: ContextUsageBucket[];
  tips: ContextUsageTip[];
  computedAt: string;
}
```

展示标签（对齐截图文案）：

| id | label |
| --- | --- |
| `system` | System prompt |
| `tools` | Tool definitions |
| `rules` | Rules |
| `skills` | Skills |
| `mcp` | MCP & dynamic tools |
| `subagents` | Subagent definitions |
| `summary` | Summarized conversation |
| `conversation` | Conversation |

## 分桶规则

核心原则：**目录与定义进静态桶；正文与工具结果进 conversation；compact 摘要进 summary。**

| id | 计入 | 不计入 |
| --- | --- | --- |
| `system` | SOUL、invariant guidance、Environment、permission/fast/effort 等产品内核段 | — |
| `tools` | 内置工具 JSON schema / 定义 | 工具调用结果 |
| `rules` | Project Instructions、Custom Instructions、常驻规则正文、USER 等用户/项目规则 | 被工具读入后的文件正文 → `conversation` |
| `skills` | 技能目录（名称 + 描述） | skill 正文打开后 → `conversation` |
| `mcp` | MCP instructions、MCP/动态工具目录与 schema | MCP 调用结果 → `conversation` |
| `subagents` | 可委派子 agent / delegation 说明文案 | 子 agent 实际对话内容 |
| `summary` | compact 产生的摘要消息 | — |
| `conversation` | 用户/助手消息、thinking、所有 tool results、读入附件/文件正文、本轮 Project Memory reminder | — |

Memory：v1 不设独立桶；本轮注入的 Project Memory reminder 计入 `conversation`。

空桶：桌面分段条可隐藏或极窄；列表可隐藏 tokens 为 0 的行（实现时与截图一致优先隐藏空桶）。

## 估算与换模

### 估算

- v1：`tokens = ceil(characterCount / 4)`，与现有 compact 启发式一致。
- `estimatedInputTokens` = 各桶 tokens 之和。
- 软提示可用带 padding 的总量（例如与 compact 相同的 4/3）判断「接近满窗」，列表展示仍用未 padding 的桶值，避免 UI 数字与相加不一致的观感问题；规格约定：**列表与环上主数字用未 padding 总和；tip 阈值可用 padded 总量。**
- `estimator` 固定为 `"heuristic_v1"`，为后续真实 tokenizer 预留替换点，不改桶模型。

### 同 session 换模型

- 快照始终使用当前 `session.runtime.model` 对应的 `contextWindow` / `outputLimit`。
- 换模后立即重算：`buckets` 可保持（同启发式），`percentFull` 随新分母变化。
- 不把上一模型的 provider `usage.input_tokens` 当作新模型精确校准源。
- 若 `estimatedInputTokens > contextWindow`：`percentFull` **允许大于 1**（例如 1.2 表示 120%），便于从小窗换入时一眼看出溢出；UI 可显示 `120% Full` 或告警态。
- 无 `contextWindow` 元数据：`percentFull = null`，环显示不可用，托盘仍列出各桶 token。

## 数据流

1. **触发**：打开托盘、`/context usage`、session 模型变更、至少在一次 run 结束后刷新；打开托盘时应拉取最新快照。
2. **组装**：Assembler 读取当前可获得的 system 分段、内置 tools、MCP/动态工具、subagent 文案、session messages（区分 summary 与其余）。
3. **输出**：生成 `ContextUsageSnapshot`（含 tips）。
4. **消费**：Desktop / CLI / HTTP 只读快照，不再本地重分类。

无 `sessionId` 时：只计量可静态组装部分（system/tools/rules/skills/mcp/subagents）；`conversation` 与 `summary` 为 0；report/tips 注明对话占用未计入。

## API 与 CLI

- `ContextService.usage({ cwd, sessionId? })` → `{ snapshot, report: string }`
- HTTP：`GET /context/usage?cwd=&sessionId=`（与 `/context`、`/context/status` 并列）
- CLI：`/context usage` 打印总量、百分比、每桶 token；tips 附在表下
- 用法提示：`/context [preview|status|usage]`（具体文案实现时与现有命令表一致）

## 桌面交互

对齐参考截图：

- Composer 旁 **context ring** 显示占用百分比（或无窗宽时的占位）。
- 点击打开托盘：
  - 标题：Context
  - 主信息：`N% Full` 与 `~X / Y Tokens`（Y 为当前模型窗宽）
  - 分段彩色进度条（按桶 tokens 比例）
  - 列表：色点 + 标签 + 右对齐 token（可用 K 缩写）
- 换模：立刻刷新环与托盘；溢出时告警态 + tip。
- 软提示展示在托盘内列表下方或环旁轻量文案，不阻断输入。

## 软提示

v1 阈值可写死（后续再配置化）：

| 条件 | tip 方向 |
| --- | --- |
| padded 总量 ≥ 窗宽约 85% | 建议 `/compact` 或新开对话 |
| 换模后总量 > 新窗宽 | 已超过当前模型上下文，建议先 compact |
| `tools` + `mcp` tokens ≥ 窗宽约 20% | 提示工具/MCP 定义偏多 |
| 无 sessionId 的静态快照 | 说明对话占用未计入 |
| 部分来源读取失败 | 说明快照可能不完整 |

Tips 仅文案；用户仍可发送消息。

## 错误与降级

- 单个来源读取失败：该部分记 0，并加 tip；不整单失败。
- Assembler 异常：环保留上次成功快照或显示不可用；不阻断 composer。
- 模型列表缺少窗宽：见上文 `percentFull = null` 行为。

## 测试要求

- 分桶纯函数：固定输入断言各桶 tokens 与总和；tool result 只进 `conversation`。
- 换模：同内容 128K→256K 时 buckets 不变、`percentFull` 约减半；反向超窗时 tip 出现且不拦截发送。
- API/CLI：有/无 `sessionId`；与 preview/status 共存。
- Desktop：ring、托盘标签与顺序、无窗宽降级的组件测试。
- 回归：现有 `/context`、compact、`setModel` 路径不被破坏。

## 后续规划（本规格外）

1. 真实 tokenizer，及同模型下用 provider usage 校准总量。
2. 桶内 items 下钻（按 MCP server、rule 文件、skill）。
3. tip 阈值可配置。
4. 用本观测指导动态 MCP 目录加载、长工具输出落盘等减负能力（另开规格）。

## 验收标准

1. 有活跃 session 时，桌面环与 `/context usage` 对同一快照给出一致的总量与分桶。
2. 托盘视觉结构与参考截图同构：百分比、总量、分段条、分类列表。
3. 同 session 切换到不同 `contextWindow` 的模型后，百分比随新窗宽更新；溢出时有软提示且可继续输入。
4. 工具定义与工具结果分属 `tools`/`mcp` 与 `conversation`。
5. compact 摘要计入 `summary`，不与 `conversation` 混计。
)
