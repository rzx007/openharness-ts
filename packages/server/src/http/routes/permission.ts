import { Hono } from "hono";

import type { StorePermissionBroker } from "../../permissions/index.js";
import type { RequestTraceRegistry } from "../control/index.js";

import {
  errorResponse,
  jsonResponse,
  readJson,
  readLimit,
  readPermissionStatus,
  type HttpPermissionStatus,
} from "../support.js";

export interface PermissionRoutesContext {
  permissions: Pick<StorePermissionBroker, "listRequests" | "reply">;
  traces: Pick<RequestTraceRegistry, "get">;
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
      const requests = context.permissions.listRequests({
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
        const request = context.permissions.reply({
          requestId,
          traceId: context.traces.get(c.req.raw),
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
