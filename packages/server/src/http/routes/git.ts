import { Hono } from "hono";

import { errorResponse, jsonResponse, readJson } from "../support.js";
import type { GitService } from "../../settings-api.js";

export interface GitRoutesContext {
  gitService?: GitService;
}

export function createGitRoutes(context: GitRoutesContext): Hono {
  return new Hono()
    .get("/diff", async (c) => {
      if (!context.gitService) return errorResponse(501, "Git service is not configured");
      const cwd = c.req.query("cwd") ?? undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      const full = c.req.query("full") === "true" || c.req.query("full") === "1";
      try {
        return jsonResponse(await context.gitService.diff({ cwd, full }));
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/branch", async (c) => {
      if (!context.gitService) return errorResponse(501, "Git service is not configured");
      const cwd = c.req.query("cwd") ?? undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      const list = c.req.query("list") === "true" || c.req.query("list") === "1";
      try {
        return jsonResponse(await context.gitService.branch({ cwd, list }));
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/status", async (c) => {
      if (!context.gitService) return errorResponse(501, "Git service is not configured");
      const cwd = c.req.query("cwd") ?? undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(await context.gitService.status({ cwd }));
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/commit", async (c) => {
      if (!context.gitService) return errorResponse(501, "Git service is not configured");
      const body = await readJson(c);
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!cwd) return errorResponse(400, "cwd is required");
      if (!message) return errorResponse(400, "message is required");
      try {
        return jsonResponse(await context.gitService.commit({ cwd, message }));
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : String(error));
      }
    });
}
