import process from "node:process";
import type { Settings } from "@openharness/core";
import type { TeammateSpawnConfig } from "@openharness/swarm";

/**
 * 把一个 teammate spawn 配置翻译成一次性子进程的 argv。
 *
 * 我们没有 Python 端的 `--task-worker` 长驻 worker 模式，所以这里用 CLI 的
 * `--print`（非交互一次性）模式：teammate 跑完 prompt 输出结果即退出。这让
 * Explore/Plan/verification 等子代理可以用各自的人格（systemPrompt）独立完成
 * 一轮工作；多轮对话（sendMessage）留待后续 worker 后端。
 *
 * 关键点：
 * - cliEntry 取自 `process.argv[1]`（与 runTuiMode 同样的拿入口路径写法）。
 * - model 用 `config.model ?? settings.model` 兜底：inherit 类 agent 的
 *   agentDef.model 为 undefined，必须回退到父进程模型，否则 teammate 会退回
 *   CLI 默认 provider/model。
 * - 不把 api-key 放进 argv（进程列表对其他用户可见）；teammate 复用同一份
 *   ~/.openharness/settings.json，并从继承的 env 里取 key。
 */
export function buildTeammateCommand(
  config: TeammateSpawnConfig,
  settings: Settings,
): { argv: string[] } {
  const cliEntry = process.argv[1] ?? "";
  const model = config.model ?? settings.model;

  const argv: string[] = [
    process.execPath,
    cliEntry,
    "--print",
    config.prompt,
    "--model",
    model,
  ];

  // 继承 provider 相关（非密钥）配置，存在才加。
  if (settings.provider) argv.push("--provider", settings.provider);
  if (settings.baseUrl) argv.push("--base-url", settings.baseUrl);
  if (settings.apiFormat) argv.push("--api-format", settings.apiFormat);

  // 权限模式继承父进程。
  argv.push("--permission-mode", settings.permission.mode);

  // 各自人格（Explore/Plan/verification 等）。
  if (config.systemPrompt) argv.push("-s", config.systemPrompt);

  return { argv };
}
