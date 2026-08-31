import type { ContextProposal, ContextTopic } from "./types.js";

const DEVELOPMENT_PREFIXES = ["node.", "git.", "test.", "code.", "development.", "workflow."];

export function routeContextTopic(proposal: ContextProposal): ContextTopic {
  if (proposal.kind === "environment_fact") return "environment";
  if (proposal.kind === "project_rule") return proposal.scope === "project" ? "rules" : "pending";
  if (proposal.kind === "project_knowledge") return proposal.scope === "project" ? "knowledge" : "pending";
  if (proposal.scope !== "user") return "pending";
  if (proposal.semanticKey.startsWith("ui.")) return "ui-design";
  if (DEVELOPMENT_PREFIXES.some((prefix) => proposal.semanticKey.startsWith(prefix))) {
    return "development-workflow";
  }
  return "preferences";
}
