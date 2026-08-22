import { Hono } from "hono";

import type { SessionExportFormat } from "../../session/index.js";
import {
  SessionMaintenanceError,
  type SessionMaintenanceService,
} from "../../application/session/index.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

export interface SessionUtilityRoutesContext {
  maintenance: Pick<
    SessionMaintenanceService,
    "compact" | "exportSession" | "getUsage" | "listMcpServers" | "remember" | "rewind"
  >;
}

function maintenanceErrorResponse(error: unknown, fallbackStatus: number): Response {
  const status = error instanceof SessionMaintenanceError ? error.status : fallbackStatus;
  return errorResponse(status, error instanceof Error ? error.message : String(error));
}

export function createSessionUtilityRoutes(context: SessionUtilityRoutesContext): Hono {
  return new Hono()
    .get("/:sessionId/mcp", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        return jsonResponse({ servers: await context.maintenance.listMcpServers(sessionId) });
      } catch (error) {
        return maintenanceErrorResponse(error, 500);
      }
    })
    .get("/:sessionId/usage", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        return jsonResponse(await context.maintenance.getUsage(sessionId));
      } catch (error) {
        return maintenanceErrorResponse(error, 500);
      }
    })
    .post("/:sessionId/export", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const body = await readJson(c);
      const forceJson = body.json === true || body.format === "json";
      const filename = typeof body.filename === "string" ? body.filename : undefined;
      const format: SessionExportFormat =
        forceJson || (filename?.endsWith(".json") ?? false) ? "json" : "md";
      try {
        return jsonResponse(await context.maintenance.exportSession(sessionId, { format, filename }));
      } catch (error) {
        return maintenanceErrorResponse(error, 400);
      }
    })
    .post("/:sessionId/compact", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        return jsonResponse(await context.maintenance.compact(sessionId));
      } catch (error) {
        return maintenanceErrorResponse(error, 500);
      }
    })
    .post("/:sessionId/rewind", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const body = await readJson(c);
      const rawCount = body.count ?? 1;
      const count = typeof rawCount === "number" ? rawCount : Number.parseInt(String(rawCount), 10);
      if (!Number.isInteger(count) || count < 1) {
        return errorResponse(400, "count must be a positive integer");
      }
      try {
        return jsonResponse(await context.maintenance.rewind(sessionId, count));
      } catch (error) {
        return maintenanceErrorResponse(error, 500);
      }
    })
    .post("/:sessionId/remember", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        return jsonResponse(await context.maintenance.remember(sessionId));
      } catch (error) {
        return maintenanceErrorResponse(error, 500);
      }
    });
}
