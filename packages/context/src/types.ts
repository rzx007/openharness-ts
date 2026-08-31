export type ContextScope = "user" | "machine" | "project";

export type ContextKind =
  | "user_preference"
  | "project_rule"
  | "project_knowledge"
  | "environment_fact";

export type ContextTopic =
  | "preferences"
  | "ui-design"
  | "development-workflow"
  | "rules"
  | "knowledge"
  | "environment"
  | "pending";

export type ContextEntryStatus = "active" | "candidate" | "superseded" | "disabled";
export type ContextSensitivity = "none" | "sensitive" | "secret";
export type ContextOrigin = "explicit_user" | "automatic_extraction" | "context_api";

export interface ContextProposal {
  title: string;
  content: string;
  kind: ContextKind;
  scope: ContextScope;
  scopeKey?: string;
  semanticKey: string;
  confidence: number;
  sensitivity: ContextSensitivity;
  evidence: string;
  replace: boolean;
}

export interface ContextEntryRecord {
  id: string;
  title: string;
  scope: ContextScope;
  scopeKey: string;
  kind: ContextKind;
  semanticKey: string;
  topic: ContextTopic;
  content: string;
  normalizedContent: string;
  status: ContextEntryStatus;
  sensitivity: ContextSensitivity;
  confidence: number;
  importance: number;
  origin: ContextOrigin;
  sourceSessionId?: string;
  sourceMessageId?: string;
  supersedesId?: string;
  candidateReason?: string;
  useCount: number;
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type ContextDocumentSegment =
  | { type: "text"; content: string }
  | { type: "entry"; entry: ContextEntryRecord };

export interface ContextTopicDocument {
  schemaVersion: 2;
  scope: ContextScope;
  scopeKey: string;
  topic: ContextTopic;
  title: string;
  updatedAt: number;
  segments: ContextDocumentSegment[];
}

export type ContextConflictDecision =
  | { status: "create" }
  | { status: "noop" | "conflict" | "replace"; existingId: string };

export type ContextMutationAction = "created" | "updated" | "replaced" | "noop" | "candidate" | "rejected";

export interface ContextItemMutationResult {
  action: ContextMutationAction;
  proposal: ContextProposal;
  entryId?: string;
  reason?: string;
}

export interface ContextBatchMutationResult {
  items: ContextItemMutationResult[];
}
