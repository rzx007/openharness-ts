/**
 * @openharness/client 公共导出。
 *
 * 面向 TUI / Web / Desktop：typed HTTP API、SSE 解析、事件 reducer、replay+live 同步。
 * 客户端只做展示与控制，不拥有 agent runtime。
 */

export { OpenHarnessApiError, OpenHarnessClient, streamServerSentEvents } from "./client.js";
export { applyEvent, applyEvents, applySessionSnapshot, createInitialClientState } from "./reducer.js";
export { selectSessionMessagesWithParts } from "./selectors.js";
export { hydrateState, syncEvents } from "./sync.js";
export type {
  AdmitClientPromptInput,
  CreateClientSessionInput,
  EventSyncOptions,
  InputDelivery,
  InterruptSessionResponse,
  ListClientMessagePartsOptions,
  ListEventsOptions,
  ListMessagesOptions,
  ListPermissionsOptions,
  ListSessionsOptions,
  OpenHarnessClientOptions,
  OpenHarnessClientState,
  OpenHarnessServerHealth,
  PermissionRequestRecord,
  PermissionStatus,
  PromptResponse,
  ReplyPermissionInput,
  SessionBucket,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionStateSnapshot,
  SyncEventUpdate,
} from "./types.js";
export type { SessionMessageWithParts } from "./selectors.js";
