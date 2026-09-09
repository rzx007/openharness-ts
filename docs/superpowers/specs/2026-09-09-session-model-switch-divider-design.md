# Session 模型切换分割提示设计

## 目标

用户在已有 Session 中主动切换模型后，在对话时间线的准确位置显示一条持久分割提示：`模型已切换 A → B`。关闭并重新打开 Session、恢复历史或从该位置之后分叉时，提示仍然存在；这条提示不能进入模型上下文。

## 方案

复用现有 `system` 消息存储结构，不新增数据库消息角色。通过结构化 metadata 把它标记为只供界面展示的时间线消息：

```ts
{
  presentation: {
    kind: "model_switch",
    fromModel: "GLM-5.3",
    toModel: "GLM-5.3-Flash"
  }
}
```

消息同时包含一段纯文本作为导出和旧客户端的降级内容。新客户端识别 metadata 后渲染为左右横线和居中文案。

## 为什么需要持久化

当前 `session.model` 只保存 Session 此刻使用的模型。它能在重启后恢复当前选择，但无法说明切换发生在对话的哪个位置，也无法还原 `fromModel`。因此仅靠当前状态不能稳定重建分割提示。

Codex 的公开行为也区分主动与自动变化：用户主动选择模型可以保留确认提示；模式切换带来的自动模型变化不应持续写入时间线，避免噪声。本设计只在 Session 模型确实发生变化时记录，不为相同模型、失败请求或内部路由变化创建提示。

## 写入流程

入口仍是 `SessionApplicationService.updateSession`：

1. 读取更新前 Session 和运行时模型。
2. 合并 metadata 并得到更新后的模型。
3. 在同一个 `SessionStore.transaction` 中更新 Session；当模型 ID 发生变化时，创建一条 `role: "system"` 消息及其文本 part。
4. 消息 metadata 保存 `kind`、`fromModel` 和 `toModel`。
5. 事务成功后关闭旧 Agent runtime、失效上下文占用缓存并发布新增事件。

把 Session 更新与提示消息放进同一事务，避免模型已切换但时间线提示缺失，或提示存在但模型更新失败。

## 模型上下文隔离

`buildAgentTranscript` 在处理角色之前识别 presentation metadata。带有受支持 presentation kind 的消息直接跳过，不转换成 Core `system` 消息。

过滤必须发生在服务端构建 Agent transcript 的统一入口，而不是只在桌面端隐藏。这样普通运行、恢复、压缩和后续模型请求都不会看见这条 UI 提示。

未知的 `system` 消息保持现有行为，继续进入模型上下文；只过滤明确标记且 schema 合法的 presentation 消息，避免误吞正常系统指令。

## 展示流程

桌面端沿用现有 `ConversationEntry` 的 system 分支：

1. `MessageBlock` 读取 presentation metadata。
2. `model_switch` 交给独立的 `ModelSwitchDivider` 组件。
3. 组件显示细横线、切换图标和 `模型已切换 A → B`。
4. 模型名称先按当前模型目录解析 label；找不到时直接显示持久化的模型 ID。
5. 普通 system 消息仍按现有的小号弱化文本展示。

组件不提供按钮，不占用消息工具栏，也不成为滚动锚点。

## 历史、分叉与导出

- 恢复：消息和 part 已在持久存储中，Session view 会按 seq 恢复到原位置。
- 分叉：现有 `forkSessionWithHistory` 会复制分叉点之前的消息、metadata 和 part，因此提示自然跟随历史范围。
- 导出：保留提示文本，让导出的 Markdown/JSON 能解释后续回答为何使用不同模型。
- 压缩：presentation 消息不进入模型上下文；若压缩替换了早期 transcript，它可以与被压缩的早期消息一起消失，不额外阻止压缩。

## 边界行为

- 初次创建 Session 不显示“模型已切换”。
- 选择当前模型不写入新消息。
- 更新请求失败不写入消息。
- Session 正在运行而拒绝切换时不写入消息。
- 只记录模型 ID 变化；仅 provider 变化不在本次范围内。
- 自动模型路由、后端安全降级和 Plan/Default 等模式变化不走这个记录入口。
- 连续多次主动切换分别记录，忠实保留时间线。

## 测试

- Session application 测试：模型变化时在同一更新中新增一条带结构化 metadata 的 system 消息和文本 part。
- Session application 测试：相同模型与失败更新不新增提示。
- Agent transcript 测试：合法的 `model_switch` presentation 消息被过滤，普通 system 消息仍然保留。
- Store 分叉测试：分割提示在分叉范围内时被复制，范围外时不复制。
- Desktop 组件测试：合法 metadata 渲染成分割线和模型名称；普通 system 消息保持旧样式；缺失 label 时回退模型 ID。
- 运行相关包测试、Desktop 类型检查和全仓类型检查。

## 验收标准

- 模型切换成功后立即出现与参考图相同语义的分割提示。
- 重开 Session 后提示位置和内容不变。
- 后续模型请求的 transcript 中不包含分割提示文本。
- 相同模型、失败切换和自动路由不会制造提示。
- 不新增数据库迁移，不修改现有消息角色枚举。
