import type { ProviderInputCapabilities } from "@openharness/api";
import type { ContentBlock, ModelInputCapabilities } from "@openharness/core";
import type { SessionInputAttachmentRecord } from "@openharness/protocol";

export type AttachmentRoutingErrorCode =
  | "attachment_model_capability_unknown"
  | "attachment_model_unsupported"
  | "attachment_provider_capability_unknown"
  | "attachment_provider_unsupported"
  | "attachment_intent_unavailable"
  | "attachment_kind_unsupported"
  | "attachment_media_type_unsupported"
  | "attachment_materialization_failed"
  | "attachment_routing_aborted";

export interface AttachmentRoutingDecision {
  assetId: string;
  intent: SessionInputAttachmentRecord["intent"];
  mediaType: string;
  route: "native_image" | "blocked";
  reason?: AttachmentRoutingErrorCode;
}

export interface RouteAttachmentBatchInput {
  text: string;
  attachments: readonly SessionInputAttachmentRecord[];
  modelCapabilities: ModelInputCapabilities;
  providerCapabilities: ProviderInputCapabilities;
  signal?: AbortSignal;
}

export interface NativeAttachmentRouteResult {
  content: ContentBlock[];
  decisions: AttachmentRoutingDecision[];
}

export class AttachmentRoutingError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: AttachmentRoutingErrorCode,
    message: string,
    readonly assetIds: string[],
    readonly decisions: AttachmentRoutingDecision[],
  ) {
    super(message);
    this.name = "AttachmentRoutingError";
  }
}
