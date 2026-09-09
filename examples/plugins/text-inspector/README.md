# Text Inspector 原生插件样例

这个样例演示 Skill 如何将用户文本交给 Node Tool，并按返回行号解释问题。插件 ID 为 `example.text-inspector`，版本为 `1.0.0`，不申请权限。宿主在独立 Node 子进程中加载 `tools/index.mjs` 的 `registerTools` 导出。

入口由 `.openharness-plugin/plugin.json` 显式声明：`skills/check-text/SKILL.md` 提供调用指引，`references/rules.md` 解释检查规则，`tools/index.mjs` 提供全局工具名 `TextInspectorCheck`。

输入示例：

```json
{ "text": "ok  \n\titem\n" }
```

返回结果的 `content[0].text` 是以下 JSON 字符串：

```json
{
  "findings": [
    { "line": 1, "code": "trailing-whitespace" },
    { "line": 2, "code": "tab-indentation" }
  ],
  "truncated": false
}
```

只接受 `text` 字段，长度上限为 100,000 个 UTF-16 代码单元。按 LF 分行并移除行末单个 CR；同行先报告行首制表符，再报告行尾空白。最多返回 100 条问题，存在更多问题时 `truncated` 为 `true`。无效输入由宿主返回 `tool_input_invalid`。

工具只处理传入文本，无文件读写或额外进程调用，也不返回原始文本片段，因此声明 `safeToRetry: true`。同步检查受输入长度限制；它不承诺在同步循环期间及时收到取消消息。

真实 `.mjs` 通过 JSDoc 引用 `@openharness/plugins/sdk` 的 `NativeToolRegister` 类型，无运行期 SDK 依赖，也无需安装样例依赖。在仓库根目录运行：

```sh
node node_modules/typescript/bin/tsc -p packages/plugins/tsconfig.sdk-examples.json
```

在 `packages/agent-runtime` 目录运行真实子进程验收：

```sh
node ../../node_modules/vitest/vitest.mjs run src/native-tools/text-inspector.test.ts
```

`packages/plugins` 的 `check-types` 同时检查公开子路径类型用例和这份实际 `.mjs`。样例目录也参与相关测试与类型检查的 Turbo 缓存输入。
