import type { SessionStore } from "@openharness/services";

export interface ListSessionsQuery {
  cwd?: string;
  includeArchived?: boolean;
  includeChildren?: boolean;
  limit?: number;
}

/**
 * Session 只读查询门面：列表（可隐藏 child）、详情、messages/parts、session state。
 * 不触发 runtime warm，也不改 store。
 */
export class SessionQueryService {
  constructor(private readonly store: Pick<
    SessionStore,
    | "getSession"
    | "getSessionState"
    | "listMessageParts"
    | "listMessages"
    | "listSessions"
    | "resolveSessionListTitle"
  >) {}

  listSessions(input: ListSessionsQuery): ReturnType<SessionStore["listSessions"]> {
    let sessions = this.store.listSessions({
      cwd: input.cwd,
      includeArchived: input.includeArchived,
      limit: input.limit,
    });
    if (!input.includeChildren) {
      sessions = sessions.filter((session) => !session.parentId);
    }
    return sessions.map((session) => ({
      ...session,
      title: this.store.resolveSessionListTitle(session.id),
    }));
  }

  getSession(sessionId: string): ReturnType<SessionStore["getSession"]> {
    return this.store.getSession(sessionId);
  }

  getSessionState(sessionId: string): ReturnType<SessionStore["getSessionState"]> {
    return this.store.getSessionState(sessionId);
  }

  listMessages(
    sessionId: string,
    input: Parameters<SessionStore["listMessages"]>[1],
  ): ReturnType<SessionStore["listMessages"]> {
    return this.store.listMessages(sessionId, input);
  }

  listMessageParts(
    sessionId: string,
    input: Parameters<SessionStore["listMessageParts"]>[1],
  ): ReturnType<SessionStore["listMessageParts"]> {
    return this.store.listMessageParts(sessionId, input);
  }
}
