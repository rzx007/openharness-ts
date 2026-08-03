import { Hono } from "hono";

import {
  errorResponse,
  jsonResponse,
  readJson,
  readLimit,
  readPermissionStatus,
  type HttpPermissionStatus,
} from "./http-support.js";

export interface PermissionRoutesContext {
  listRequests(input: {
    sessionId?: string;
    status?: HttpPermissionStatus;
    toolName?: string;
    limit?: number;
  }): unknown[];
  reply(input: {
    requestId: string;
    traceId: string;
    status: "approved" | "denied" | "expired";
    decision?: "once" | "session";
    clientId?: string;
  }): unknown;
  traceIdForRequest(request: Request): string;
}

export function createPermissionRoutes(context: PermissionRoutesContext): Hono {
  return new Hono()
    .get("/", (c) => {
      let status: HttpPermissionStatus | undefined;
      try {
        status = readPermissionStatus(c.req.query("status"));
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : String(error));
      }
      const requests = context.listRequests({
        sessionId: c.req.query("sessionId") ?? undefined,
        status,
        toolName: c.req.query("toolName") ?? undefined,
        limit: readLimit(c.req.query("limit")),
      });
      return jsonResponse({ requests });
    })
    .post("/:requestId/reply", async (c) => {
      const requestId = c.req.param("requestId");
      if (!requestId) return errorResponse(400, "requestId is required");
      const body = await readJson(c);
      const status = body.status;
      if (status !== "approved" && status !== "denied" && status !== "expired") {
        return errorResponse(400, "status must be approved, denied, or expired");
      }
      const decision = body.decision;
      if (decision !== undefined && decision !== "once" && decision !== "session") {
        return errorResponse(400, "decision must be once or session");
      }

      try {
        const request = context.reply({
          requestId,
          traceId: context.traceIdForRequest(c.req.raw),
          status,
          decision,
          clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        });
        return jsonResponse({ request });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResponse(message.includes("not found") ? 404 : 409, message);
      }
    });
}
