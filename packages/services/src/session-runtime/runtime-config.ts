/**
 * @deprecated 公共运行配置函数已经移动到 `@openharness/protocol`。
 * 这里暂时转发旧入口，避免一次性修改所有服务端调用方。
 */
export {
  patchSessionRuntimeMetadata,
  readRuntimeMetadata,
  readSessionRuntimeConfig,
  runtimeMetadataChanged,
} from "@openharness/protocol";
export type {
  SessionApiFormat,
  SessionRuntimeConfig,
  SessionRuntimeConfigPatch,
} from "@openharness/protocol";
