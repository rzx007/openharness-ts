import type { SessionStore } from "@openharness/services";

export interface ListSessionsQuery {
  cwd?: string;
  includeArchived?: boolean;
  includeChildren?: boolean;
  limit?: number;
}

/** Read-only session facade used by HTTP routes. */
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
