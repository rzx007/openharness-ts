import { Hono } from "hono";

import { errorResponse, jsonResponse, readJson } from "../support.js";
import type { MemoryService } from "../../application/index.js";
import type { DaemonControlService } from "../control/index.js";

export interface MemoryRoutesContext {
  memoryService?: MemoryService;
  control: Pick<DaemonControlService, "acquireCwdMutation" | "closeRuntimesForCwd">;
}

export function createMemoryRoutes(context: MemoryRoutesContext): Hono {
  return new Hono()
    .get("/", async (c) => {
      if (!context.memoryService) return errorResponse(501, "Memory service is not configured");
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(await context.memoryService.list({ cwd }));
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/:entryId", async (c) => {
      if (!context.memoryService) return errorResponse(501, "Memory service is not configured");
      const cwd = c.req.query("cwd");
      const entryId = c.req.param("entryId");
      if (!cwd) return errorResponse(400, "cwd is required");
      if (!entryId) return errorResponse(400, "entryId is required");
      try {
        const entry = await context.memoryService.get({ cwd, id: entryId });
        if (!entry) return errorResponse(404, `Memory entry not found: ${entryId}`);
        return jsonResponse({ entry });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/", async (c) => {
      if (!context.memoryService) return errorResponse(501, "Memory service is not configured");
      const body = await readJson(c);
      if (typeof body.cwd !== "string") return errorResponse(400, "cwd is required");
      if (typeof body.content !== "string" || !body.content.trim()) {
        return errorResponse(400, "content is required");
      }
      const lease = context.control.acquireCwdMutation(body.cwd);
      if (!lease) {
        return errorResponse(409, "Cannot update memory while session runs are active for this cwd");
      }
      const tags = Array.isArray(body.tags)
        ? body.tags.filter((tag): tag is string => typeof tag === "string")
        : undefined;
      try {
        const entry = await context.memoryService.add({ cwd: body.cwd, content: body.content, tags });
        await context.control.closeRuntimesForCwd(body.cwd);
        return jsonResponse({ entry }, 201);
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      } finally {
        lease.release();
      }
    })
    .delete("/:entryId", async (c) => {
      if (!context.memoryService) return errorResponse(501, "Memory service is not configured");
      const cwd = c.req.query("cwd");
      const entryId = c.req.param("entryId");
      if (!cwd) return errorResponse(400, "cwd is required");
      if (!entryId) return errorResponse(400, "entryId is required");
      const lease = context.control.acquireCwdMutation(cwd);
      if (!lease) {
        return errorResponse(409, "Cannot update memory while session runs are active for this cwd");
      }
      try {
        const deleted = await context.memoryService.remove({ cwd, id: entryId });
        if (!deleted) return errorResponse(404, `Memory entry not found: ${entryId}`);
        await context.control.closeRuntimesForCwd(cwd);
        return jsonResponse({ deleted: true, id: entryId });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      } finally {
        lease.release();
      }
    });
}
