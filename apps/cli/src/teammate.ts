import process from "node:process";
import type { Settings } from "@openharness/core";
import type { TeammateSpawnConfig } from "@openharness/swarm";

/**
 * 把一个 teammate spawn 配置翻译成一次性子进程的 argv。
 *
 * teammate 走 `--task-worker` 模式(对齐 Python):每次读一行 stdin 跑一轮即退;
 * 多轮对话 = SendMessage 写 stdin 时 TaskManager 懒复活重启进程(重启不保留
 * 上下文,与 Python 同)。prompt 经 stdin 而非 argv。
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
): { argv: string[]; env: Record<string, string> } {
  const cliEntry = process.argv[1] ?? "";
  const model = config.model ?? settings.model;

  // --task-worker:prompt 不进 argv(经 stdin 喂,createAgentTask 负责),
  // 顺带消掉超长 prompt 撑爆 Windows argv 的隐患;多轮 = TaskManager 懒复活重启。
  const argv: string[] = [
    process.execPath,
    cliEntry,
    "--task-worker",
    "--model",
    model,
  ];

  // 继承 provider 相关（非密钥）配置，存在才加。
  if (settings.provider) argv.push("--provider", settings.provider);
  if (settings.baseUrl) argv.push("--base-url", settings.baseUrl);
  if (settings.apiFormat) argv.push("--api-format", settings.apiFormat);

  // 权限模式：缺省一律 default，不继承 leader。继承会形成死循环——leader
  // full_auto → worker 也 full_auto 自行放行，permission-sync 文件流的批准
  // 路径成为死代码；leader default 又派不出 Agent。default 让 worker 写操作
  // 经文件流由 leader 集中裁决（leader full_auto 时 checker 照批，留审计点）。
  argv.push("--permission-mode", config.permissionMode ?? "default");

  // 各自人格（Explore/Plan/verification 等）。
  if (config.systemPrompt) argv.push("-s", config.systemPrompt);

  // agent 级字段运行时生效：将 AgentDefinition 中解析的约束传给子进程。
  if (config.maxTurns != null) argv.push("--max-turns", String(config.maxTurns));
  if (config.effort) argv.push("--effort", config.effort);
  if (config.allowedTools?.length) argv.push("--allowed-tools", config.allowedTools.join(","));
  if (config.disallowedTools?.length) argv.push("--disallowed-tools", config.disallowedTools.join(","));

  // 所有 teammate 都以 swarm worker 身份运行：只读工具自动放行（D.4）。
  // 只读放行本就安全，让 Explore/Plan 默认就能干活，不必父进程开 full_auto。
  argv.push("--swarm-worker");

  // D.1 Swarm context recovery：预分配的会话 ID 让 worker 跨重启加载自己的历史。
  if (config.sessionId) argv.push("--session-id", config.sessionId);

  // swarm 身份环境变量（D.5）：worker 侧 isSwarmWorker()/createPermissionRequest
  // 据此识别自己并寻址团队的 permission pending 目录。命名沿用 Python 原版。
  const env: Record<string, string> = {
    CLAUDE_CODE_TEAM_NAME: config.team,
    CLAUDE_CODE_AGENT_ID: `${config.name}@${config.team}`,
    CLAUDE_CODE_AGENT_NAME: config.name,
  };

  return { argv, env };
}
