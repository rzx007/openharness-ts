import {
  createContentSignature,
  type ContextProposal,
  type ContextScope,
} from "@openharness/context";

import { detectContextSensitivity } from "./context-sensitive-data.js";

export interface ContextRuntimeScope {
  userScopeKey: "local-user";
  machineId?: string;
  projectId?: string;
}

export interface ContextClassifier {
  classify(input: { content: string; runtimeScope: ContextRuntimeScope }): Promise<ContextProposal[]>;
}

export interface ContextIntentResolverOptions {
  classifier?: ContextClassifier;
}

export class ContextIntentResolver {
  private readonly classifier?: ContextClassifier;

  constructor(options: ContextIntentResolverOptions = {}) {
    this.classifier = options.classifier;
  }

  async resolve(content: string, runtimeScope: ContextRuntimeScope): Promise<ContextProposal[]> {
    const statements = splitStatements(content);
    const proposals = statements.flatMap((statement) => resolveStatement(statement, runtimeScope));
    if (proposals.length > 0) return proposals;
    if (!this.classifier) return [fallbackProposal(cleanStatement(content), runtimeScope)];
    const classified = await this.classifier.classify({ content, runtimeScope });
    return classified.map((proposal) => validateClassifiedProposal(proposal, runtimeScope));
  }
}

function splitStatements(content: string): string[] {
  return content
    .replace(/^\s*(?:请)?(?:全局)?记住\s*[：:,]?\s*/u, "")
    .split(/[；;\n]+/u)
    .map(cleanStatement)
    .filter(Boolean);
}

function cleanStatement(value: string): string {
  return value.trim().replace(/[。.!！]+$/u, "").trim();
}

function resolveStatement(statement: string, runtimeScope: ContextRuntimeScope): ContextProposal[] {
  const evidence = statement;
  const replace = /(?:改成|改为|替换为|以后用|switch to)/iu.test(statement);
  const sensitivity = detectContextSensitivity(statement);
  const packageManager = statement.match(/\b(pnpm|npm|yarn|bun)\b/iu)?.[1]?.toLowerCase();

  if (sensitivity === "secret") {
    return [proposal({
      title: "敏感凭据",
      content: statement,
      kind: "user_preference",
      scope: "user",
      scopeKey: runtimeScope.userScopeKey,
      semanticKey: "secret.rejected",
      confidence: 1,
      sensitivity,
      evidence,
      replace,
    })];
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/u.test(statement)) {
    const scope: ContextScope = runtimeScope.projectId ? "project" : "machine";
    return [proposal({
      title: "内部服务地址",
      content: `${statement}。`,
      kind: "environment_fact",
      scope,
      scopeKey: runtimeScope.projectId ?? runtimeScope.machineId,
      semanticKey: "environment.internal_endpoint",
      confidence: 0.95,
      sensitivity,
      evidence,
      replace,
    })];
  }
  if (packageManager && /(?:这个项目|当前项目|项目|包管理器|改成|改为)/u.test(statement)) {
    return [proposal({
      title: "项目包管理器",
      content: `当前项目使用 ${packageManager}。`,
      kind: "project_rule",
      scope: "project",
      scopeKey: runtimeScope.projectId,
      semanticKey: "node.package_manager",
      confidence: 0.99,
      sensitivity,
      evidence,
      replace,
    })];
  }
  if (/(?:提交前|commit 前).*(?:运行|执行).*(?:测试|test)/iu.test(statement)) {
    return [proposal({
      title: "提交前运行测试",
      content: "当前项目提交前必须运行测试。",
      kind: "project_rule",
      scope: "project",
      scopeKey: runtimeScope.projectId,
      semanticKey: "git.pre_commit_test",
      confidence: 0.99,
      sensitivity,
      evidence,
      replace,
    })];
  }
  if (/(?:代码)?注释.*中文/u.test(statement)) {
    return [proposal({
      title: "代码注释语言",
      content: "代码注释使用中文。",
      kind: "user_preference",
      scope: "user",
      scopeKey: runtimeScope.userScopeKey,
      semanticKey: "code.comment_language",
      confidence: 0.97,
      sensitivity,
      evidence,
      replace,
    })];
  }
  const verbosity = statement.match(/(?:回答|回复).*?(简洁|详细)/u)?.[1];
  if (verbosity) {
    return [proposal({
      title: "回答详细程度",
      content: verbosity === "简洁" ? "回答尽量简洁。" : "回答可以详细一些。",
      kind: "user_preference",
      scope: "user",
      scopeKey: runtimeScope.userScopeKey,
      semanticKey: "response.verbosity",
      confidence: 0.97,
      sensitivity,
      evidence,
      replace,
    })];
  }
  if (packageManager && /(?:我喜欢|偏好|prefer)/iu.test(statement)) {
    return [proposal({
      title: "包管理器偏好",
      content: `偏好使用 ${packageManager}。`,
      kind: "user_preference",
      scope: "user",
      scopeKey: runtimeScope.userScopeKey,
      semanticKey: "node.package_manager_preference",
      confidence: 0.7,
      sensitivity,
      evidence,
      replace,
    })];
  }
  return [];
}

function fallbackProposal(content: string, runtimeScope: ContextRuntimeScope): ContextProposal {
  return proposal({
    title: "待确认偏好",
    content: `${content}。`,
    kind: "user_preference",
    scope: "user",
    scopeKey: runtimeScope.userScopeKey,
    semanticKey: `preference.${createContentSignature(content).slice(0, 12)}`,
    confidence: 0.6,
    sensitivity: detectContextSensitivity(content),
    evidence: content,
    replace: false,
  });
}

function proposal(value: ContextProposal): ContextProposal {
  return value;
}

function validateClassifiedProposal(
  proposal: ContextProposal,
  runtimeScope: ContextRuntimeScope,
): ContextProposal {
  if (!proposal.title?.trim() || !proposal.content?.trim() || !proposal.semanticKey?.trim()) {
    throw new Error("Classifier returned an incomplete context proposal");
  }
  const sensitivity = detectContextSensitivity(`${proposal.content}\n${proposal.evidence}`);
  const scopeKey = proposal.scope === "user"
    ? runtimeScope.userScopeKey
    : proposal.scope === "project"
      ? runtimeScope.projectId
      : runtimeScope.machineId;
  return { ...proposal, scopeKey, sensitivity: sensitivity === "none" ? proposal.sensitivity : sensitivity };
}
