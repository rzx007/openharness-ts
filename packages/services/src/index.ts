export { CompactService } from "./compact";
export type { CompactOptions } from "./compact";

export {
  SessionStore,
  patchSessionRuntimeMetadata,
  readRuntimeMetadata,
  readSessionRuntimeConfig,
  runtimeMetadataChanged,
  type SessionRuntimeConfig,
  type SessionRuntimeConfigPatch,
  type SessionStoreOptions,
} from "./session-runtime";
export type {
  AdmitPromptInput,
  AppendEventInput,
  AppendMessagePartDeltaInput,
  CreateCronRunInput,
  CreateMessageInput,
  CreatePermissionRequestInput,
  CreateRunInput,
  CreateSessionTaskInput,
  CreateSessionInput,
  InputDelivery,
  CronJobRecord,
  CronRunCause,
  CronRunRecord,
  CronRunStatus,
  ListEventsOptions,
  ListMessagePartsOptions,
  ListMessagesOptions,
  ListPermissionRequestsOptions,
  ListSessionsOptions,
  PermissionRequestRecord,
  PermissionStatus,
  ReplyPermissionInput,
  RunStatus,
  SessionMessagePartRecord,
  SessionMessagePartStatus,
  SessionMessagePartType,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessageRecord,
  SessionMessageRole,
  SessionRecord,
  SessionRunRecord,
  SessionTaskRecord,
  SessionTaskStatus,
  SessionStatus,
  SessionStateSnapshot,
  UpsertMessagePartInput,
  UpsertCronJobInput,
  UpdateCronJobInput,
  UpdateRunInput,
  UpdateSessionTaskInput,
  UpdateSessionInput,
  ReplaceTranscriptInput,
  ReplaceTranscriptMessageInput,
  ReplaceTranscriptPartInput,
} from "./session-runtime";
export {
  getProjectSessionDir,
  saveSessionSnapshot,
  loadSessionSnapshot,
  listSessionSnapshots,
  loadSessionById,
  deleteSessionById,
  exportSessionMarkdown,
  type StoredMessageLike,
  type SessionSnapshotPayload,
  type SessionListItem,
  type SaveSessionOptions,
} from "./session";

export {
  CronScheduler,
  executeCronJob,
  validateCronExpression,
  computeNextRunTime,
} from "./cron";
export type {
  CronExecutionCause,
  CronExecutor,
  CronJob,
  CronTriggerOptions,
  CronTriggerResult,
} from "./cron";

export { estimateTokens } from "./token-estimation";
export type { TokenEstimate } from "./token-estimation";

export { LspClient } from "./lsp";
export type { LspServerConfig } from "./lsp";


export { TaskManager, getTaskManager, resetTaskManager } from "./tasks";
export type {
  TaskInfo,
  TaskType,
  TaskStatus,
  CompletionListener,
  TaskListener,
  TaskEvent,
  AwaitTaskResult,
  CreateShellTaskOptions,
  CreateAgentTaskOptions,
} from "./tasks";

export {
  DEFAULT_TOOL_OUTPUT_INLINE_CHARS,
  DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS,
  DEFAULT_MICROCOMPACT_TOOL_RESULT_CHARS,
  toolOutputInlineChars,
  toolOutputPreviewChars,
  microcompactToolResultChars,
  isMicrocompactableToolResult,
} from "./tool-outputs.js";

export {
  MAX_SESSION_MEMORY_CHARS,
  getSessionMemoryDir,
  getSessionMemoryPath,
  prepareSessionMemoryMetadata,
  getSessionMemoryContent,
  updateSessionMemoryFile,
  buildSessionMemoryDocument,
  sessionMemoryToCompactText,
  type CheckpointMessageLike,
} from "./session-memory.js";

export {
  EXTRACTION_SYSTEM_PROMPT,
  hasMemoryWritesSince,
  buildExtractionPrompt,
  parseExtractionRecords,
  applyExtractionRecords,
  extractMemoriesFromTurn,
  type ExtractionRecord,
  type ExtractionResult,
  type ExtractMemoriesOptions,
} from "./memory-extract.js";
export * from "./autodream/index.js";
