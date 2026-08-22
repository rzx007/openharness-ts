import type { AgentEffects } from "@openharness/core";

import {
  createAssembledAgent,
  type OpenHarnessAgent,
  type OpenHarnessAgentOptions,
} from "./agent.js";
import {
  composeOpenHarnessAgent,
  type AgentIdentity,
} from "./agent-composition.js";
import { AgentChildRegistry } from "./child-agent.js";
import { AgentEventBus } from "./event-source.js";

interface InternalAgentOptions {
  eventBus: AgentEventBus;
  effects: AgentEffects;
  childDirectory: AgentChildRegistry;
  identity?: AgentIdentity;
}

/** 默认 Node 组装：会读取本机配置、发现扩展，并安装 Node 能力。 */
export async function createDefaultNodeAgent(
  options: OpenHarnessAgentOptions = {},
): Promise<OpenHarnessAgent> {
  const eventBus = new AgentEventBus(options.onEvent);
  const capabilities = options.hostCapabilities;
  const effects: AgentEffects = {
    requestPermission:
      capabilities?.permissions.requestPermission ??
      options.requestPermission ??
      (async () => ({
        status: "denied",
        reason: "No permission effect configured",
      })),
    ...(capabilities?.schedules ?? options.schedules
      ? { schedules: capabilities?.schedules ?? options.schedules }
      : {}),
  };
  return await createDefaultNodeAgentInternal(options, {
    eventBus,
    effects,
    childDirectory: new AgentChildRegistry(),
  });
}

async function createDefaultNodeAgentInternal(
  options: OpenHarnessAgentOptions,
  internal: InternalAgentOptions,
): Promise<OpenHarnessAgent> {
  const composition = await composeOpenHarnessAgent(options, {
    ...internal,
    createAgent: (childOptions, identity) =>
      createDefaultNodeAgentInternal(childOptions, {
        eventBus: internal.eventBus,
        effects: internal.effects,
        childDirectory: internal.childDirectory,
        identity,
      }),
  });
  return createAssembledAgent({
    ...composition,
    eventBus: internal.eventBus,
    effects: internal.effects,
    identity: internal.identity,
    childDirectory: internal.childDirectory,
  });
}
