# Native Plugin 当前实现

> 状态：当前实现。完整设计见 [原生插件与外部转换器设计](./superpowers/specs/2026-08-25-native-plugin-and-converters-design.md)，执行进度见 [实施计划](./superpowers/plans/2026-08-25-native-plugin-and-claude-converter.md)。

## 运行流程

```text
手写 Native Plugin
或 Claude Code / Codex Source -> Converter -> Native Plugin
  -> validateNativePlugin
  -> 不可变 cache 快照
  -> installed.json
  -> Runtime 读取用户安装记录并重新校验快照
  -> 加载 Skills / Agents / Hooks / MCP / Node Tool
```

Runtime 唯一识别的 manifest 是：

```text
<plugin-root>/.openharness-plugin/plugin.json
```

根级旧 `plugin.json`、snake_case 字段和 Claude/Codex manifest 不会被 Runtime 猜测或兼容。

## Manifest

Native v1 使用 `schemaVersion: 1`、稳定 dotted `id`、kebab-case `name` 和显式 `components`。每条组件路径必须以 `./` 开头。Validator 会同时检查规范化路径和符号链接后的真实路径，越界、缺失或重复来源都会产生结构化诊断。

Skills、Agents、Hooks、MCP 和 Node Tool 已进入加载闭环。Tool 不会在 daemon 主进程动态 import；Runtime 会为每个插件版本启动独立 Tool Host 子进程。LSP、Workflow、Channel、Provider、UI 等已预留 schema，但会返回 unsupported 诊断。

## 安装状态

```text
~/.openharness-ts/plugins/
├─ cache/<plugin-id>/<version>-<digest>/
├─ data/<plugin-id>/
├─ sources/
└─ installed.json
```

安装流程先校验源目录，再复制到 `cache/<plugin-id>/` 下的临时候选目录并校验副本，校验成功后原子改名为不可变的 `<version>-<digest>/` 快照，最后更新 `installed.json` 指向该快照。最终快照必须是真实目录，不能是符号链接或 Windows 目录联接。`installed.json` 同时记录 manifest version、内容摘要和权限批准。重装同一 ID 会创建新快照，不会原地替换正在被旧 Runtime 使用的目录；若同摘要快照已经损坏，重装会先隔离损坏目录，再从已验证的原始内容重建。普通卸载保留 `data/`。

Native Plugin 只支持用户级安装；当前 cwd 只作为插件运行时的工作目录，不形成独立安装或独立权限批准。旧的 project/local 记录会被忽略并提示重新以 user scope 安装，不能自动扩大成全局授权。Runtime 加载前先确认非 link 缓存根不是符号链接或目录联接，再重新核对实际 manifest 的 ID、版本和权限，并校验内容摘要；任一项与安装记录不一致都会拒绝激活。启停使用稳定插件 ID，不再修改 Settings。

## 外部转换

`@openharness/plugin-converters` 拥有外部格式逻辑。Claude Code Converter 按以下流程工作：

```text
detect -> inspect -> plan -> approve -> convert -> Native validate
```

转换产物保存 `provenance.json`、`plan.json` 和 `report.json`，并逐项标记 exact、adapted、unsupported 或 blocked。转换过程只读源文件，不 import JavaScript、不启动 Hook/MCP、不联网或安装依赖。

转换完成后，目录本身就是普通 Native Plugin：组件直接位于 `skills/`、`agents/`、`hooks.json` 和 `mcp.json`，不会再套 `payload/` 或 `generated/`。`plugin.json.metadata` 只保留 converted/sourceFormat/Converter 信息；Installer、Runtime、UI 和 CLI 均按 Native Plugin 管理，`.openharness-conversion/` 仅供审计，删除它不影响安装和运行。

### Codex 导入

Codex 转换器识别 `.codex-plugin/plugin.json`，以及 schema 明确为 Agent Plugins 1.0.0 的根级 `plugin.json`。后者仍是外部输入，需要转换才能安装。portable 格式固定读取 `skills/` 和 `mcp.json`；内联 `extensions.com.openai` 整体替代旧 Codex manifest 的扩展设置。

先查看转换预览：

```sh
ohs plugin convert ./my-codex-plugin --from codex --dry-run
ohs plugin convert ./my-codex-plugin --from codex --dry-run --json
```

确认预览中的每项变化后，重复传入对应 `--approve <item>`，选择输出目录或直接安装：

```sh
ohs plugin convert ./my-codex-plugin --from codex --output ./native-plugin
ohs plugin install ./my-codex-plugin --from codex
```

以上两条命令适用于不需要额外批准的纯 Skills 插件。有 MCP、有损项或 `agents/openai.yaml` 时，必须补上预览列出的批准参数。输出目录必须不存在，且不能位于源目录内。

Skills 保留原来的包内位置及相对资源路径；Native manifest 逐个声明 `SKILL.md`，不会把说明文档误当作技能。MCP 输出到 `mcp/servers.json`，网络地址或进程请求写入 Native permissions，安装时再校验批准。

首版可转换普通 HTTP/SSE MCP，以及通过 PATH 运行、参数不依赖本地脚本或安装命令的 stdio MCP。Apps、Hooks、`agents/openai.yaml` 中的调用策略/工具依赖、复杂认证、未知 MCP 字段、插件根变量和自动下载依赖等明确报告 `unsupported`；批准表示接受这些内容不进入 Native 运行配置。全部组件都不支持时，不生成可安装产物。

具体边界见 [Codex 转换器设计](./superpowers/specs/2026-09-09-codex-plugin-converter-design.md)，验证步骤见 [实现计划](./superpowers/plans/2026-09-09-codex-plugin-converter.md)。

本次还修正了共享来源摘要的二进制编码歧义。历史转换计划需要重新 `inspect/plan`；已经安装的 Native 快照与权限记录不需要迁移。

## 诊断与安全边界

manifest 解析、路径验证、组件加载和安装都返回带 phase/code/message 的诊断。单个组件损坏不会让其他独立组件消失，插件会以 degraded/partial 状态呈现。

生产 Runtime 中没有 Claude/Codex parser，也没有第三方 Tool 的主进程动态 import。外部格式变化只影响对应 Converter。

Native Tool 调用路径有 runtime 级控制：

- 每次调用会写审计日志，包含插件 ID、tool 名、cwd、参数摘要、耗时、完成/失败状态和错误码；
- 调用输入会先按 `inputSchema` 的常用 JSON Schema 约束校验，失败时返回 `tool_input_invalid`，不会进入插件代码；
- 每个插件版本有并发上限，超过时返回 `tool_concurrency_limit`；
- 调用超时和取消会通过 AbortSignal 传给插件；插件不响应取消时，host 会在 grace period 后被强制结束并注销该插件的 tool；
- stdout、stderr 和插件主动日志都有大小限制，超出后截断并抑制后续输出；
- installed record 中缺少已批准权限时，Runtime 会跳过该插件并提示重新批准或重装。

当前隔离边界仍是“进程与环境变量隔离”，不是操作系统级沙箱。第三方 Node Tool 仍可直接调用 Node 文件、网络和进程 API；manifest 权限目前用于 OpenHarness 宿主能力和运行时闸门，不能替代容器、受限系统用户或系统调用过滤。
