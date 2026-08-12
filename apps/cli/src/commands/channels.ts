import { Command } from "commander";
import type { Settings, ChannelsConfig } from "@openharness/core";
import type { ChannelAdapter } from "@openharness/channels";

/**
 * `ohs channels` 子命令（D.2，TS 自有接线——Python 的 manager/bridge
 * 是库，消费方 ohmo 不移植，TS 按 swarm 既例直接接进 CLI）。
 *
 * serve：长驻进程。settings.channels 组装 adapters → MessageBus +
 * ChannelManager + ChannelBridge 跑通「通道消息 → 引擎 → 回复」，
 * SIGINT/SIGTERM 优雅退出。
 */

export interface AssembledChannels {
  adapters: ChannelAdapter[];
  /** 按通道名的 ACL 白名单（交给 manager 集中过滤，fail-closed）。 */
  allowFrom: Record<string, string[]>;
  warnings: string[];
}

/** 按 settings.channels 组装启用的 adapter 实例（纯组装，不连接）。 */
export async function assembleChannelAdapters(
  channels: ChannelsConfig | undefined,
): Promise<AssembledChannels> {
  const adapters: ChannelAdapter[] = [];
  const allowFrom: Record<string, string[]> = {};
  const warnings: string[] = [];

  const feishu = channels?.feishu;
  if (feishu?.enabled) {
    if (!feishu.appId || !feishu.appSecret) {
      warnings.push("feishu 已启用但缺 appId/appSecret，跳过。");
    } else {
      const { FeishuAdapter } = await import("@openharness/channels");
      adapters.push(
        new FeishuAdapter({
          appId: feishu.appId,
          appSecret: feishu.appSecret,
          encryptKey: feishu.encryptKey,
          verificationToken: feishu.verificationToken,
          replyAtBotNames: feishu.replyAtBotNames,
          // ACL 不传给 adapter——集中在 ChannelManager（fail-closed）。
        }),
      );
      allowFrom["feishu"] = Object.values(feishu.allowFrom ?? {});
    }
  }

  return { adapters, allowFrom, warnings };
}

async function runChannelsServe(): Promise<void> {
  const { loadSettings } = await import("@openharness/core");
  const settings: Settings = await loadSettings({});

  const { adapters, allowFrom, warnings } = await assembleChannelAdapters(settings.channels);
  for (const w of warnings) console.warn(`[channels] ${w}`);
  if (adapters.length === 0) {
    console.error(
      "[channels] 没有启用任何通道。在 settings.json 配置 channels.feishu（enabled/appId/appSecret/allowFrom）。",
    );
    process.exitCode = 1;
    return;
  }

  const { createOpenHarnessAgent } = await import("@openharness/agent-runtime");
  // 无头模式 ask 无人确认会全拒——放行只读工具让"看"可用,写/Bash 仍拒。
  // 比 swarm 的 READ_ONLY_TOOLS 再剔除 WebFetch/WebSearch:远程通道语境下
  // Read+WebFetch 构成"读本地文件→出站外带"链(且 WebFetch 可打内网)。
  // 信任环境想要联网,自己加 settings.permission.autoApproveTools: ["WebFetch"]。
  const { READ_ONLY_TOOLS } = await import("@openharness/permissions");
  // const channelSafeTools = [...READ_ONLY_TOOLS].filter(
  //   (t) => t !== "WebFetch" && t !== "WebSearch",
  // );
  const channelSafeTools = [...READ_ONLY_TOOLS];
  const agent = await createOpenHarnessAgent({
    settings,
    autoApproveTools: channelSafeTools,
  });

  const { MessageBus, ChannelManager, ChannelBridge } = await import("@openharness/channels");
  const bus = new MessageBus();
  const manager = new ChannelManager(adapters, bus, {
    allowFrom,
    sendProgress: settings.channels?.sendProgress,
    sendToolHints: settings.channels?.sendToolHints,
    onWarning: (w) => console.warn(`[channels] ${w}`),
  });
  const bridge = new ChannelBridge({
    agent,
    bus,
    onWarning: (w) => console.warn(`[channels] ${w}`),
  });

  let removeSignalHandlers = () => {};
  try {
    bridge.start();
    await manager.startAll();

    const status = manager.getStatus();
    for (const [name, s] of Object.entries(status)) {
      console.log(
        `[channels] ${name}: ${s.running ? "running" : `failed${s.lastError ? ` (${s.lastError})` : ""}`}`,
      );
    }
    if (Object.values(status).every((s) => !s.running)) {
      console.error("[channels] 所有通道启动失败，退出。");
      process.exitCode = 1;
      return;
    }
    console.log("[channels] 桥接已就绪，Ctrl+C 退出。");

    await new Promise<void>((resolve) => {
      let stopping = false;
      const shutdown = () => {
        if (stopping) {
          console.error("\n[channels] 强制退出。");
          process.exit(130);
        }
        stopping = true;
        console.log("\n[channels] 正在停止…(再按一次 Ctrl+C 强制退出)");
        resolve();
      };
      removeSignalHandlers = () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  } finally {
    const failures: unknown[] = [];
    for (const cleanup of [
      () => bridge.stop(),
      () => manager.stopAll(),
      () => agent.close(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    removeSignalHandlers();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Channel shutdown failed");
  }
}

export function createChannelsCommand(): Command {
  const cmd = new Command("channels").description("Chat channel bridge (feishu, …)");

  cmd
    .command("serve")
    .description("Start enabled channels and bridge them to the agent (long-running)")
    .action(async () => {
      await runChannelsServe();
    });

  cmd
    .command("status")
    .description("Show configured channels")
    .action(async () => {
      const { loadSettings } = await import("@openharness/core");
      const settings: Settings = await loadSettings({});
      const feishu = settings.channels?.feishu;
      if (!feishu) {
        console.log("channels: (none configured)");
        return;
      }
      const entries = Object.entries(feishu.allowFrom ?? {});
      const acl =
        entries.length === 0
          ? "allowFrom empty — ALL DENIED"
          : `allowFrom: ${entries.map(([n, id]) => `${n}(${id})`).join(", ")}`;
      console.log(`feishu: ${feishu.enabled ? "enabled" : "disabled"} (${acl})`);
    });

  return cmd;
}
