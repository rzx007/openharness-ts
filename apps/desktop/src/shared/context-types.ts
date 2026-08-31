import type {
  ContextEntryRecord,
  ContextKind,
  ContextMutationResult,
  ContextScope,
  ContextStatus,
  ContextTopic,
} from "@openharness/client";

export type DesktopContextQuery = {
  cwd: string;
  scope?: ContextScope;
  kind?: ContextKind;
};

export type DesktopContextEntryInput = { cwd: string; content: string };
export type DesktopContextEntryUpdate = {
  cwd: string;
  entryId: string;
  content: string;
  title?: string;
};
export type DesktopContextEntryTarget = { cwd: string; entryId: string };
export type DesktopContextCandidateAccept = DesktopContextEntryTarget & {
  topic?: ContextTopic;
};

export type {
  ContextEntryRecord,
  ContextKind,
  ContextMutationResult,
  ContextScope,
  ContextStatus,
  ContextTopic,
};
