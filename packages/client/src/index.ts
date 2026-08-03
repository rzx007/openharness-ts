/**
 * @openharness/client 公共导出。
 *
 * 面向 TUI / Web / Desktop：typed HTTP API、SSE 解析、事件 reducer、replay+live 同步。
 * 客户端只做展示与控制，不拥有 agent runtime。
 */

export { createPromptRequestId, OpenHarnessApiError, OpenHarnessClient, streamServerSentEvents } from "./client.js";
export { applyEvent, applyEvents, applySessionSnapshot, createInitialClientState } from "./reducer.js";
export { selectSessionMessagesWithParts } from "./selectors.js";
export {
  LOCAL_COMMAND_DETAILS,
  LOCAL_COMMAND_NAMES,
  dispatchSessionCommand,
  hasActiveRun,
  mergeCommandDetails,
  parseSlashLine,
  resolveSessionCwd,
} from "./session-commands.js";
export { hydrateState, syncEvents } from "./sync.js";
export type {
  SessionCommandHost,
  SessionCommandOutcome,
  SlashLine,
} from "./session-commands.js";
export type {
  AdmitClientPromptInput,
  AgentPersonaInfo,
  AuthStatus,
  CommandCatalogEntry,
  CommandKind,
  CommandSource,
  CompactSessionResponse,
  CreateClientSessionInput,
  CreateTaskInput,
  EventSyncOptions,
  HookInfo,
  ReloadPluginsResponse,
  RewindSessionResponse,
  InputDelivery,
  InterruptSessionResponse,
  InvokeClientCommandInput,
  InvokeCommandResponse,
  ListClientMessagePartsOptions,
  ListCommandsOptions,
  ListEventsOptions,
  ListMessagesOptions,
  ListPermissionsOptions,
  ListSessionsOptions,
  ListTasksOptions,
  McpServerStatus,
  MemoryEntryRecord,
  MemoryListResponse,
  OpenHarnessClientOptions,
  OpenHarnessClientState,
  OpenHarnessServerHealth,
  OutputStyleInfo,
  PermissionRequestRecord,
  PermissionStatus,
  PluginInfo,
  PromptResponse,
  ProviderInfo,
  RememberSessionResponse,
  ReplyPermissionInput,
  SessionBucket,
  SessionEventRecord,
  SessionExportResponse,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionTaskRecord,
  SessionStateSnapshot,
  SessionUsageResponse,
  StartDreamResponse,
  SyncEventUpdate,
  TaskSnapshot,
  UpdateClientSessionInput,
} from "./types.js";
export type { SessionMessageWithParts } from "./selectors.js";
