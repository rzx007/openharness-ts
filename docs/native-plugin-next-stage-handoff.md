# Native Plugin 后续工作交接

> 状态：当前实现之后的阶段交接。  
> 日期：2026-09-10  
> 适用范围：Native Plugin 安装后诊断、插件管理界面、作者体验、后续来源扩展与明确暂缓项。

## 1. 交接结论

插件系统当前已经走完两个关键阶段：

1. 原生插件可以被开发、校验、安装、启停、加载和调用；
2. Desktop 插件页可以导入一个本地 Native Plugin ZIP，并支持重新导入同一插件 ID 来完成手动更新或修复。

下一阶段最合适做 **Native Plugin 运行诊断 v1**。原因是：安装链路已经有了清晰反馈，但“安装成功后 Runtime 为什么没有加载、为什么某个组件不可用、用户应该怎么处理”还没有形成完整闭环。

这个阶段不要扩展来源，不做 Marketplace，不做 Agent 对话内安装，也不做自动更新。先把已安装插件的运行状态讲清楚。

## 2. 当前已经完成什么

### 原生插件基础能力

- Native Plugin 使用 `.openharness-plugin/plugin.json` 作为唯一运行时 manifest；
- manifest、组件路径、权限、平台要求和内容摘要会在安装时校验；
- 非 link 安装会复制到不可变快照目录，不原地覆盖旧版本；
- Runtime 激活前会重新校验快照、manifest ID、版本、权限和 digest；
- Skills、Agents、Hooks、MCP 和 Node Native Tools 已进入原生插件加载范围；
- Node Tool 运行在独立子进程中，已有参数校验、审计、超时、取消、并发和输出限制；
- CLI 已有本地 Native 安装、link、转换、启停、详情和卸载；
- 原生插件作者指南、SDK 类型和文本检查参考插件已经存在。

### Desktop 本地 ZIP 导入

- 插件页可以选择一个本地 Native Plugin ZIP；
- Archive Resolver 在后台复制、解压、校验路径、类型、大小、数量、压缩比、CRC 和摘要；
- Renderer 不拿到 ZIP 绝对路径或内容摘要；
- 无权限请求的插件直接安装；
- 有权限请求的插件只显示一次完整权限确认；
- 重新导入同一插件 ID 时，如果旧批准覆盖本次权限，不重复确认；
- 新版本新增权限时才重新确认；
- 新快照成功切换前保留旧安装记录；
- 重装保留原来的启停状态；
- 成功后的插件从下一次对话开始生效。

### Converter 当前状态

- Converter core、Claude Code Converter 和 Codex Converter 首版已经完成；
- 转换产物已经收敛为普通 Native Plugin 目录；
- Converter 本轮开发已经暂停；
- 后续只有在 Native 运行与管理闭环更稳定后，再考虑重新转换、转换报告展示或更多格式。

## 3. 下一阶段推荐：Native Plugin 运行诊断 v1

### 目标

让用户在插件页能看懂：

- 插件是否已经安装；
- 插件是否启用；
- 插件是否已被当前 Runtime 成功加载；
- 如果没有加载，是权限、快照、manifest、平台、组件还是运行入口的问题；
- 用户下一步应该重新导入、禁用、卸载，还是等下一次对话生效。

用户界面保持简单。对普通用户来说，插件管理只需要给出明确结果：

```text
已安装，下一次对话生效
已启用，但加载失败：缺少已批准权限
已启用，但快照损坏：请重新导入 ZIP
已禁用
```

不要在 UI 上做复杂诊断树，也不要让用户手动理解 digest、cache path 或 manifest diff。

### 建议范围

本阶段只做安装后诊断，不做安装来源扩展。

包含：

- Runtime 激活结果写成结构化诊断；
- Server 管理接口返回插件最近一次 Runtime 状态；
- Desktop 插件列表或详情页展示简单状态；
- 失败状态给出一条用户可执行建议；
- 文档说明“安装成功”和“运行成功”的区别。

不包含：

- Agent 对话内安装 ZIP；
- 自动修复按钮；
- 独立 Repair 命令；
- 自动更新和版本回滚；
- Marketplace；
- Git、npm、archive URL 来源；
- Output Styles 插件贡献；
- UI 插件贡献；
- 操作系统级沙箱。

### 建议状态模型

可以先保持很小，不需要新建复杂状态机。

```text
installed record
  ↓
Runtime reload / new conversation
  ↓
verifyInstalledNativePlugin
  ↓
loadNativePlugin
  ↓
activation diagnostic
  ↓
PluginInfo returned to Desktop / CLI
```

建议对管理接口暴露一个面向展示的字段，例如：

```ts
runtimeStatus:
  | { state: "not_loaded"; reason: "disabled" | "pending_reload" }
  | { state: "loaded"; loadedAt: string; components: RuntimeComponentSummary[] }
  | { state: "failed"; code: string; message: string; action: "reimport" | "disable" | "uninstall" | "approve" }
```

字段名称可以按现有代码调整，但语义要保持简单：列表页能显示状态，详情页能显示原因和建议动作。

### 错误码建议

第一版只需要覆盖 Runtime 激活前后最常见问题：

| code | 用户看到的含义 | 建议动作 |
|---|---|---|
| `plugin_disabled` | 插件已禁用 | 启用后下次对话生效 |
| `reload_required` | 已安装或更新，但当前对话未加载 | 开新对话或重载插件 |
| `snapshot_missing` | 插件文件缺失 | 重新导入 ZIP |
| `snapshot_tampered` | 插件文件与安装记录不一致 | 重新导入 ZIP |
| `manifest_mismatch` | manifest ID 或版本与安装记录不一致 | 重新导入 ZIP |
| `permission_missing` | 插件请求了未批准权限 | 重新导入并确认权限 |
| `component_unsupported` | 当前版本不支持该组件类型 | 查看详情，等待后续支持 |
| `component_invalid` | 某个组件声明无效 | 修正插件后重新导入 |
| `tool_host_failed` | Native Tool 子进程启动失败 | 查看详情，修正插件或禁用 |

内部可以保留更细的诊断信息，但 UI 第一版只映射到这几类。

## 4. 可能需要改的代码入口

接手时建议先看这些文件，具体命名以当前代码为准：

- `packages/plugins/src/installation/`：安装记录、不可变快照、安装前后校验；
- `packages/plugins/src/load-native-plugin.ts`：Native Plugin 加载和 unsupported 组件诊断；
- `packages/plugins/src/verify-installed-native-plugin.ts` 或同类文件：Runtime 激活前校验入口；
- `packages/agent-runtime/src/extensions.ts`：Runtime 组合插件贡献的入口；
- `packages/agent-runtime/src/native-tools/`：Native Tool 进程启动、调用和失败；
- `packages/server/src/application/default-services/plugin-service.ts`：Desktop 和 CLI 共用的插件管理应用层；
- `packages/server/src/application/settings-api.ts`：管理接口类型；
- `packages/client/src/types/index.ts`：前端共享类型；
- `apps/desktop/src/main/features/plugin/plugin-service.ts`：Desktop 主进程插件操作；
- `apps/desktop/src/renderer/src/components/desktop/plugin-page/`：插件页列表、详情和导入反馈；
- `apps/cli/src/commands/plugin.ts`：如果本阶段同步 CLI 详情输出，再改这里。

不要让 Desktop 直接读 `installed.json` 或 cache。Desktop 只能通过 Server / Plugin Service 拿结构化结果。

## 5. 验收标准

本阶段完成时，至少要能证明以下场景：

- 已禁用插件在插件页显示为禁用，不显示成加载失败；
- 刚导入或重装成功的插件能显示“下一次对话生效”；
- manifest 被改坏时，Runtime 拒绝加载，并且插件页仍能看到该插件和失败原因；
- 快照缺失或 digest 不一致时，插件页提示重新导入；
- 插件新增未批准权限时，Runtime 不加载，管理接口返回可读错误；
- 某个组件 unsupported 时，不影响同插件内其他已支持组件的诊断展示；
- Native Tool 子进程启动失败时，不拖垮整个插件管理页；
- Desktop、CLI 和 Server 对同一个插件看到的状态一致。

测试不需要铺满全仓库。优先用聚焦测试覆盖：

- 安装记录到 Runtime 诊断的转换；
- Plugin Service 返回的 `PluginInfo`；
- Desktop 插件页状态文案；
- 一个真实或近真实插件的损坏快照场景。

## 6. 交互原则

用户侧保持“成或失败”的风格：

- 成功：告诉用户插件已安装或已更新，下一次对话生效；
- 失败：告诉用户失败原因和一个明确动作；
- 权限：只在新增权限时确认一次；
- 诊断：默认折叠或放在详情里，不把内部校验步骤摆到主流程；
- 不出现“请理解 cache / digest / manifest diff”这类要求。

推荐文案方向：

```text
已安装，下一次对话生效。
加载失败：插件文件不完整，请重新导入 ZIP。
加载失败：插件请求了新的权限，请重新导入并确认权限。
部分能力不可用：当前版本暂不支持该组件。
```

## 7. 后续路线图

### P0：运行诊断与管理收口

这是下一阶段推荐目标。

- Runtime 诊断返回管理接口；
- Desktop 插件页展示运行状态；
- 插件详情页展示版本、启停、组件、权限和最近诊断；
- 作者文档补充排障入口。

### P1：作者体验小修

在运行诊断之后做，成本低、收益稳定。

- 补充“如何打 ZIP、如何重装验证、如何看诊断”；
- 让参考插件 README 覆盖常见失败；
- 明确 `reload-plugins` 与“下一次对话生效”的区别；
- 保持 SDK 类型和实际示例同步。

### P2：Agent 对话内安装本地 Native ZIP

等插件页和诊断稳定后再做。

- 对话里接收本地 ZIP；
- 调用同一条 Archive Resolver 和 Plugin Service；
- 仍然只反馈成功、失败、权限确认；
- 不在对话里设计复杂管理界面。

### P3：更多 Source Resolver

按来源逐个阶段做，不要一次铺开。

建议顺序：

1. 本地 archive 格式补齐，例如 `.tar`、`.tar.gz`；
2. Git URL + 固定 commit；
3. npm package + version / integrity；
4. archive URL + checksum；
5. Marketplace。

每个来源都必须在进入 Installer 前变成 Native Plugin candidate。

### P4：声明式组件贡献

优先考虑比动态代码更容易收紧边界的组件：

- Themes；
- Monitors；
- Workflows；
- Output Styles。

其中 `output_styles` 当前已经决定暂缓，不要抢跑。

### P5：更高风险能力

放在后面单独设计：

- Channels；
- Providers；
- UI contributions；
- 自动依赖安装；
- 第三方 Converter；
- 操作系统级沙箱；
- Wasm Tool Runtime。

这些能力涉及认证、隔离、生命周期或远程来源信任，不适合和当前诊断阶段混在一起。

## 8. 明确暂缓项

以下内容暂时不要做，除非重新开规格说明：

- `output_styles` 插件贡献；
- Agent 对话内安装本地 ZIP；
- 自动更新；
- 独立 Repair 命令；
- 版本回滚；
- 旧快照垃圾回收 UI；
- Marketplace；
- Git / npm 远程来源；
- 第三方 Converter 动态加载；
- UI 插件贡献；
- Native LSP 插件贡献；
- 操作系统级沙箱。

其中“手动更新或修复”已经由“重新导入同一插件 ID 的 ZIP”覆盖。不要再为它新建一套并行流程。

## 9. 接手时的推荐阅读顺序

1. [插件系统最终形态交接](./plugin-system-handoff.md)：完整边界和长期路线；
2. [Native Plugin 当前实现](./plugins-contributions-design.md)：当前代码已经做到什么；
3. [原生插件开发指南](./native-plugin-authoring.md)：作者视角和参考插件；
4. [Desktop 本地 Native Plugin ZIP 导入设计](./superpowers/specs/2026-09-09-desktop-native-plugin-zip-import-design.md)：当前导入入口；
5. [Native Plugin 重新安装核心设计](./superpowers/specs/2026-09-10-native-plugin-reinstall-core-design.md)：同 ID 重装、权限复用和旧记录保留；
6. `packages/plugins/src/installation/`：安装与快照；
7. `packages/server/src/application/default-services/plugin-service.ts`：统一管理入口；
8. `packages/agent-runtime/src/extensions.ts`：Runtime 激活入口；
9. `apps/desktop/src/renderer/src/components/desktop/plugin-page/`：插件管理 UI。

如果这些文档和代码冲突，以当前代码、migration 和自动化测试为准；文档随后修正。

## 10. 下一阶段建议规格标题

如果继续按当前节奏推进，下一份规格建议命名为：

```text
docs/superpowers/specs/2026-09-10-native-plugin-runtime-diagnostics-v1-design.md
```

实施计划可以命名为：

```text
docs/superpowers/plans/2026-09-10-native-plugin-runtime-diagnostics-v1.md
```

规格只覆盖诊断闭环，不覆盖来源扩展。这样阶段边界清楚，容易审查，也不容易把插件系统重新拖回“大而全”的状态。
