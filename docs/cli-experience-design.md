# 设计：CLI 体验 — oh provider / --dry-run / oh setup（E.1）

> 状态：已批准，待实现。E.2 选择性斜杠命令留后续规划，不在本批。

## 范围（本批）

1. `oh provider`（list/use/add/edit/remove）—— 从 CLI 管 provider + key。
2. `oh --dry-run` —— 不跑模型，预览解析后的运行时配置 + readiness。
3. `oh setup` —— 交互式首次配置向导。

**oh provider 最小版**：只做 `settings.provider` + `credentials.json[name]` 的 API key；
**不做**命名 ProviderProfile 体系 / keyring（那是 C.2，单独做）。copilot/codex OAuth 属 E.4，范围外。

## 现状（可复用）

- 子命令：auth/mcp/plugin/cron/config/version/doctor（无 provider/setup/dry-run）。
- `CredentialStorage`（auth）：`storeCredential(p,'api_key',v)`/`loadApiKey(p)`/`clearProviderCredentials(p)`/`listStoredProviders()`。
- `PROVIDERS`/`findByName`（api）：20 个内置 provider（name/envKey/defaultBaseURL/displayName）。
- `loadSettings`/`saveSettings`（core）。
- doctor 的 `checkApiKey(settings, storage)`（apps/cli/src/doctor.ts）→ {ok, source}，dry-run 复用。

## 组件

### a) `oh provider` 子命令（新建 apps/cli/src/commands/provider.ts）
- `provider list`：遍历 PROVIDERS（+ credentials 里有但不在 PROVIDERS 的），每行：name、是否 active（`settings.provider`）、key 来源（credentials.json / env `<ENVKEY>` / none）、registry 的 displayName/defaultBaseURL。
- `provider use <name> [--model <m>]`：校验 name（findByName，未知给提示但仍允许）；`settings.provider=name`，有 `--model` 则 `settings.model=m`；saveSettings。
- `provider add <name> --api-key <key> [--model <m>] [--base-url <url>] [--use]`：`storeCredential(name,'api_key',key)`；`--model`→settings.model、`--base-url`→settings.baseUrl（全局）、`--use`→同时 settings.provider=name；saveSettings（有变更才存）。
- `provider edit <name> [--api-key|--model|--base-url]`：同 add 的更新语义（至少给一个）。
- `provider remove <name>`：`clearProviderCredentials(name)`；若它是 active 则提示（不强制改 settings）。
- 抽可测纯函数：如 `formatProviderRow(spec, { active, keySource })`、`resolveKeySource(name, creds, env)`。

### b) `oh --dry-run`
- index.ts 加 `--dry-run` flag；MainOptions.dryRun。
- mainAction 早分支（在 backendOnly/tui/print 之前）：若 dryRun → 调 `runDryRun(settings, options)` 并 return。
- `runDryRun`（apps/cli/src/dry-run.ts，可测）：打印
  - model / provider / **key 来源**(checkApiKey) / baseURL / apiFormat / permission-mode
  - 工具数（createDefaultToolRegistry + 黑白名单过滤后的 count）
  - MCP servers（settings.mcpServers 的名字 + 推断 transport）
  - skills 数（loadSkillsThreeSources 后 count）
  - **readiness**：`ready`（key 有、model 有）/ `warning`（如无 skills/无 MCP，非阻塞）/ `blocked`（无 key）。
  - 不创建 API client、不调模型。

### c) `oh setup`（交互向导，新建 apps/cli/src/commands/setup.ts）
- readline：① 列已知 provider（编号）让选 → ② 输 API key → ③ 输 model（给该 provider 的默认/建议）→ ④ 确认 → 写 settings.json（provider/model/apiFormat=该 provider 的 backendType 对应）+ `storeCredential(name,'api_key',key)`。
- 复用 a) 的配置写入逻辑（抽 `applyProviderConfig({name, apiKey, model, baseUrl, setActive})`）。
- 已有配置时提示"将覆盖"，可取消。

## 测试

- `formatProviderRow`/`resolveKeySource`：active 标记、key 来源(credentials/env/none) 判定。
- `applyProviderConfig`：写 settings.provider/model + 存 credential（mock storage + settings）。
- `runDryRun` 的 readiness 判定纯函数：有 key+model→ready、无 key→blocked、缺 skills/MCP→warning。
- provider use/add/remove 的 settings/credentials 变更（mock）。
- setup 的选择→配置映射纯函数（交互层难测，把"选择结果→applyProviderConfig 入参"抽出来测）。

## 范围外

- 命名 ProviderProfile 体系 + keyring（C.2）。
- copilot/codex OAuth（E.4）。
- E.2 斜杠命令（后续规划）。
