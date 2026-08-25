# Native Plugin 当前实现

> 状态：当前实现。完整设计见 [原生插件与外部转换器设计](./superpowers/specs/2026-08-25-native-plugin-and-converters-design.md)，执行进度见 [实施计划](./superpowers/plans/2026-08-25-native-plugin-and-claude-converter.md)。

## 运行流程

```text
手写 Native Plugin
或 Claude Code Source -> Converter -> Native Plugin
  -> validateNativePlugin
  -> 版本 cache
  -> installed.json
  -> Runtime 按 cwd/scope 发现
  -> 加载 Skills / Agents / Hooks / MCP
```

Runtime 唯一识别的 manifest 是：

```text
<plugin-root>/.openharness-plugin/plugin.json
```

根级旧 `plugin.json`、snake_case 字段和 Claude/Codex manifest 不会被 Runtime 猜测或兼容。

## Manifest

Native v1 使用 `schemaVersion: 1`、稳定 dotted `id`、kebab-case `name` 和显式 `components`。每条组件路径必须以 `./` 开头。Validator 会同时检查规范化路径和符号链接后的真实路径，越界、缺失或重复来源都会产生结构化诊断。

Skills、Agents、Hooks、MCP 已进入加载闭环。Tool 目前只 recognized，不会在 daemon 主进程动态 import；LSP、Workflow、Channel、Provider、UI 等已预留 schema，但会返回 unsupported 诊断。

## 安装状态

```text
~/.openharness-ts/plugins/
├─ cache/<plugin-id>/<version>-<digest>/
├─ data/<plugin-id>/
├─ sources/
└─ installed.json
```

安装流程先校验源目录，再复制到临时 cache、校验副本，最后原子切换 `installed.json`。权限批准记录保存在 installed record，不会写回 manifest。普通卸载保留 `data/`。

Runtime 按当前 cwd 解析 user、managed、project 和 local scope。启停使用稳定插件 ID，不再修改 Settings。

## 外部转换

`@openharness/plugin-converters` 拥有外部格式逻辑。Claude Code Converter 按以下流程工作：

```text
detect -> inspect -> plan -> approve -> convert -> Native validate
```

转换产物保存 `provenance.json`、`plan.json` 和 `report.json`，并逐项标记 exact、adapted、unsupported 或 blocked。转换过程只读源文件，不 import JavaScript、不启动 Hook/MCP、不联网或安装依赖。

## 诊断与安全边界

manifest 解析、路径验证、组件加载和安装都返回带 phase/code/message 的诊断。单个组件损坏不会让其他独立组件消失，插件会以 degraded/partial 状态呈现。

生产 Runtime 中没有 Claude/Codex parser，也没有第三方 Tool 的主进程动态 import。外部格式变化只影响对应 Converter。
