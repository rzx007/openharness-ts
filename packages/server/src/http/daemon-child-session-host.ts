import type { ChildSessionHost } from "./child-agent-ports.js";
import type { SessionApplicationService } from "./session-application-service.js";

type ChildSessionApplication = Pick<
  SessionApplicationService,
  | "admitPrompt"
  | "archiveSessionTree"
  | "awaitRun"
  | "closeRuntime"
  | "createChildSession"
  | "interruptSession"
>;

/**
 * Daemon child-agent adapter for child session application use cases.
 * 把 createChildSession / admitPrompt / awaitRun / interrupt / archive 等调用
 * 转发到 SessionApplicationService，避免 QueryEngine 直接依赖 HTTP 用例层。
 */
export class DaemonChildSessionHost implements ChildSessionHost {
  constructor(private readonly application: () => ChildSessionApplication) {}

  async createChildSession(
    input: Parameters<ChildSessionHost["createChildSession"]>[0],
  ): ReturnType<ChildSessionHost["createChildSession"]> {
    return await this.application().createChildSession(input);
  }

  async admitPrompt(sessionId: string, content: string): ReturnType<ChildSessionHost["admitPrompt"]> {
    const admitted = this.application().admitPrompt(sessionId, { content });
    return admitted.run ? { runId: admitted.run.id } : {};
  }

  async awaitRun(
    sessionId: string,
    runId: string,
  ): ReturnType<ChildSessionHost["awaitRun"]> {
    return await this.application().awaitRun(sessionId, runId);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.application().interruptSession(sessionId);
  }

  async closeRuntime(sessionId: string): Promise<void> {
    await this.application().closeRuntime(sessionId);
  }

  async archive(sessionId: string): Promise<void> {
    await this.application().archiveSessionTree(sessionId);
  }
}
