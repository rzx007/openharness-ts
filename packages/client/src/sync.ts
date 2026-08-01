/**
 * 客户端事件同步：session 使用原子 HTTP snapshot + SSE live；
 * 无 sessionId 的全局视图使用 HTTP replay + SSE live。
 *
 * UI（如 `useServerSync`）通常消费 `syncEvents`，而不是分别调 listEvents / streamEvents。
 */

import { applyEvent, applyEvents, applySessionSnapshot, createInitialClientState } from "./reducer.js";
import type {
  EventSyncOptions,
  OpenHarnessClientState,
  SessionEventRecord,
  SyncEventUpdate,
} from "./types.js";
import type { OpenHarnessClient } from "./client.js";

/** 用已有事件列表一次性 hydrate 出客户端状态（离线/测试常用）。 */
export function hydrateState(events: Iterable<SessionEventRecord>): OpenHarnessClientState {
  return applyEvents(createInitialClientState(), events);
}

/**
 * session attach 主路径：`getSessionState` snapshot → `streamEvents` live。
 * 每应用一条（或 live 下状态确有变化的）事件就 yield `{ event, state, source }`。
 * live 阶段若 `applyEvent` 因重复 seq 返回同一引用，则跳过 yield。
 */
export async function* syncEvents(
  client: OpenHarnessClient,
  options: EventSyncOptions = {},
): AsyncIterable<SyncEventUpdate> {
  let state = createInitialClientState();
  if (options.sessionId) {
    const snapshot = await client.getSessionState(options.sessionId, { signal: options.signal });
    state = applySessionSnapshot(state, snapshot);
    yield { state, source: "snapshot" };

    for await (const event of client.streamEvents({
      cursor: snapshot.cursor,
      sessionId: options.sessionId,
      signal: options.signal,
    })) {
      const before = state;
      state = applyEvent(state, event);
      if (state !== before) yield { event, state, source: "live" };
    }
    return;
  }
  const replay = await client.listEvents({
    cursor: options.cursor,
    sessionId: options.sessionId,
    signal: options.signal,
  });

  for (const event of replay) {
    state = applyEvent(state, event);
    yield { event, state, source: "replay" };
  }

  for await (const event of client.streamEvents({
    cursor: state.lastSeq,
    sessionId: options.sessionId,
    signal: options.signal,
  })) {
    const before = state;
    state = applyEvent(state, event);
    if (state !== before) yield { event, state, source: "live" };
  }
}
