import { createContentSignature, type ContextProposal } from "@openharness/context";

import { detectContextSensitivity } from "./context-sensitive-data.js";

export interface ContextTranscriptMessage {
  role?: string;
  content: string | readonly unknown[];
}

export interface EnvironmentFactExtractor {
  extract(messages: ContextTranscriptMessage[]): ContextProposal[];
}

export class DeterministicEnvironmentFactExtractor implements EnvironmentFactExtractor {
  extract(messages: ContextTranscriptMessage[]): ContextProposal[] {
    const proposals: ContextProposal[] = [];
    for (const message of messages) {
      if (typeof message.content !== "string") continue;
      for (const match of message.content.matchAll(/https?:\/\/[^\s)\]}>，。]+/giu)) {
        proposals.push(environmentProposal("服务地址", match[0], "environment.endpoint", 0.96));
      }
      for (const match of message.content.matchAll(/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b/gu)) {
        proposals.push(environmentProposal("内部地址", match[0], "environment.internal_host", 0.96));
      }
      for (const match of message.content.matchAll(/(?:^|\s)((?:[A-Za-z]:\\|\/)[^\s，。]+)/gmu)) {
        const value = match[1];
        if (value) proposals.push(environmentProposal("环境路径", value, "environment.path", 0.95));
      }
    }
    return deduplicate(proposals);
  }
}

function environmentProposal(title: string, value: string, key: string, confidence: number): ContextProposal {
  return {
    title,
    content: `${title}：${value}`,
    kind: "environment_fact",
    scope: "project",
    semanticKey: `${key}.${createContentSignature(value).slice(0, 12)}`,
    confidence,
    sensitivity: detectContextSensitivity(value),
    evidence: value,
    replace: false,
  };
}

function deduplicate(proposals: ContextProposal[]): ContextProposal[] {
  return [...new Map(proposals.map((proposal) => [proposal.semanticKey, proposal])).values()];
}
