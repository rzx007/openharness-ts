import { randomUUID } from "node:crypto";

import {
  DEFAULT_ATTACHMENT_LIMITS,
  parseAttachmentLimits,
  type AttachmentAssetRecord,
  type AttachmentLimits,
} from "@openharness/protocol";

import type { SessionStore } from "../session-runtime/store.js";
import {
  AttachmentBlobStore,
  type AttachmentBlobRange,
} from "./attachment-blob-store.js";
import { AttachmentError, isAttachmentError } from "./attachment-errors.js";

export interface AttachmentApplicationServiceOptions {
  store: SessionStore;
  blobs: AttachmentBlobStore;
  limits?: Partial<AttachmentLimits>;
  now?: () => number;
  id?: () => string;
}

export interface ImportAttachmentInput {
  displayName: string;
  declaredMediaType?: string;
  content: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

export interface OpenAttachmentContentResult {
  asset: AttachmentAssetRecord;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  content: ReadableStream<Uint8Array>;
}

export interface AttachmentRecoveryResult {
  failedImportIds: string[];
  removedStagingNames: string[];
  retainedStagingNames: string[];
}

export class AttachmentApplicationService {
  readonly limits: AttachmentLimits;
  private readonly store: SessionStore;
  private readonly blobs: AttachmentBlobStore;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(options: AttachmentApplicationServiceOptions) {
    this.store = options.store;
    this.blobs = options.blobs;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => `att_${randomUUID()}`);
    this.limits = parseAttachmentLimits({
      ...DEFAULT_ATTACHMENT_LIMITS,
      ...options.limits,
    });
  }

  async import(input: ImportAttachmentInput): Promise<AttachmentAssetRecord> {
    const id = this.id();
    this.store.createImportingAttachment({
      id,
      displayName: input.displayName,
      ...(input.declaredMediaType
        ? { declaredMediaType: input.declaredMediaType }
        : {}),
      stagingName: `${id}.part`,
      createdAt: this.now(),
    });
    try {
      const imported = await this.blobs.import({
        uploadId: id,
        content: input.content,
        ...(input.declaredMediaType
          ? { declaredMediaType: input.declaredMediaType }
          : {}),
        maxBytes: this.limits.maxBytesPerFile,
        signal: input.signal,
      });
      return this.store.markAttachmentReady(id, {
        sha256: imported.sha256,
        sizeBytes: imported.sizeBytes,
        mediaType: imported.mediaType,
        updatedAt: this.now(),
      });
    } catch (error) {
      const normalized = normalizeAttachmentFailure(error);
      try {
        this.store.failAttachmentImport(id, normalized.code, this.now());
      } catch {
        // Preserve the original import failure. Recovery will reconcile any
        // importing record left behind by a concurrent database failure.
      }
      throw normalized;
    }
  }

  get(id: string): AttachmentAssetRecord {
    const asset = this.store.getAttachment(id);
    if (!asset) throw attachmentNotFound();
    return asset;
  }

  async openContent(
    id: string,
    range: AttachmentBlobRange = {},
  ): Promise<OpenAttachmentContentResult> {
    const asset = this.get(id);
    if (
      asset.status !== "ready" ||
      !asset.sha256 ||
      asset.sizeBytes === undefined ||
      !asset.mediaType
    ) {
      throw new AttachmentError(
        "attachment_not_ready",
        "attachment content is not ready",
      );
    }
    return {
      asset,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      mediaType: asset.mediaType,
      content: await this.blobs.open(asset.sha256, asset.sizeBytes, range),
    };
  }

  delete(id: string): AttachmentAssetRecord {
    const asset = this.get(id);
    if (asset.status !== "ready") {
      throw new AttachmentError(
        "attachment_not_ready",
        "only ready attachments can be deleted",
      );
    }
    return this.store.softDeleteUnreferencedAttachment(id, this.now());
  }

  async recover(): Promise<AttachmentRecoveryResult> {
    const importing = this.store.listImportingAttachments();
    const staging = await this.blobs.recoverStaging({
      activeNames: new Set(),
      olderThan: this.blobs.stagingCutoff(this.limits.stagingTtlMs),
    });
    const recoverableStagingNames = new Set(staging.recoverable);
    const failedImportIds: string[] = [];
    for (const asset of importing) {
      this.store.failAttachmentImport(
        asset.id,
        recoverableStagingNames.has(asset.stagingName)
          ? "attachment_aborted"
          : "attachment_storage_failed",
        this.now(),
      );
      failedImportIds.push(asset.id);
    }
    return {
      failedImportIds,
      removedStagingNames: staging.removed,
      retainedStagingNames: staging.retained,
    };
  }
}

function normalizeAttachmentFailure(error: unknown): AttachmentError {
  if (isAttachmentError(error)) return error;
  return new AttachmentError(
    "attachment_storage_failed",
    "attachment import failed",
    true,
  );
}

function attachmentNotFound(): AttachmentError {
  return new AttachmentError("attachment_not_found", "attachment not found");
}
