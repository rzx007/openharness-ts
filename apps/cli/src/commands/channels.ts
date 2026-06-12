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
      allowFrom["feishu"] = feishu.allowFrom ?? [];
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

  // 引擎组装复用 task-worker/backend 的 bootstrap 路径。
  const { SkillRegistry } = await import("@openharness/skills");
  const { CredentialStorage } = await import("@openharness/auth");
  const { bootstrap } = await import("../runtime");
  const { loadSkillsThreeSources } = await import("./main");
  const skillRegistry = new SkillRegistry();
  await loadSkillsThreeSources(skillRegistry, process.cwd(), settings);
  const bundle = await bootstrap({
    settings,
    cliOverrides: {},
    skillRegistry,
    credentialStorage: new CredentialStorage(),
  });

  const { MessageBus, ChannelManager, ChannelBridge } = await import("@openharness/channels");
  const bus = new MessageBus();
  const manager = new ChannelManager(adapters, bus, {
    allowFrom,
    sendProgress: settings.channels?.sendProgress,
    sendToolHints: settings.channels?.sendToolHints,
    onWarning: (w) => console.warn(`[channels] ${w}`),
  });
  const bridge = new ChannelBridge({ engine: bundle.queryEngine, bus });

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
    await bridge.stop();
    process.exitCode = 1;
    return;
  }
  console.log("[channels] 桥接已就绪，Ctrl+C 退出。");

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      console.log("\n[channels] 正在停止…");
      void (async () => {
        await bridge.stop();
        await manager.stopAll();
        resolve();
      })();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

export function createChannelsCommand(): Command {
  const cmd = new Command("channels").description("Chat channel bridge (feishu, …)");

  cmd
    .command("serve")
    .description("Start enabled channels and bridge them to the engine (long-running)")
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
      const acl =
        (feishu.allowFrom ?? []).length === 0
          ? "allowFrom empty — ALL DENIED"
          : `allowFrom: ${feishu.allowFrom.join(", ")}`;
      console.log(`feishu: ${feishu.enabled ? "enabled" : "disabled"} (${acl})`);
    });

  return cmd;
}
