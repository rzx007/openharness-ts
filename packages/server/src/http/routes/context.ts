import { Hono } from "hono";

import type { ContextEntryStatus, ContextKind, ContextScope, ContextTopic } from "@openharness/context";
import { ContextResourceError } from "../../application/context/context-resource-error.js";
import type { ContextResourceService } from "../../application/context/context-resource-service.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

const SCOPES = new Set<ContextScope>(["user", "machine", "project"]);
const KINDS = new Set<ContextKind>(["user_preference", "project_rule", "project_knowledge", "environment_fact"]);
const TOPICS = new Set<ContextTopic>(["preferences", "ui-design", "development-workflow", "rules", "knowledge", "environment"]);

export function createContextRoutes(context: {
  service: Pick<ContextResourceService, "list" | "get" | "add" | "update" | "remove" | "candidates" | "accept" | "reject" | "status" | "preview">;
  control: ContextMutationControl;
}): Hono {
  return new Hono()
    .get("/entries", async (c) => {
      const request = readListRequest(c.req.query());
      if (request instanceof Response) return request;
      try { return jsonResponse({ entries: await context.service.list(request) }); }
      catch (error) { return resourceError(error); }
    })
    .get("/entries/:id", async (c) => {
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try { return jsonResponse({ entry: await context.service.get({ cwd, id: c.req.param("id") }) }); }
      catch (error) { return resourceError(error); }
    })
    .post("/entries", async (c) => {
      const body = await readJson(c);
      if (typeof body.cwd !== "string" || !body.cwd.trim()) return errorResponse(400, "cwd is required");
      if (typeof body.content !== "string" || !body.content.trim()) return errorResponse(400, "content is required");
      return await mutate(context, body.cwd, async () => jsonResponse({ result: await context.service.add({ cwd: body.cwd as string, content: body.content as string }) }, 201));
    })
    .patch("/entries/:id", async (c) => {
      const body = await readJson(c);
      if (typeof body.cwd !== "string" || !body.cwd.trim()) return errorResponse(400, "cwd is required");
      if (typeof body.content !== "string" || !body.content.trim()) return errorResponse(400, "content is required");
      return await mutate(context, body.cwd, async () => jsonResponse({ entry: await context.service.update({ cwd: body.cwd as string, id: c.req.param("id"), content: body.content as string, ...(typeof body.title === "string" ? { title: body.title } : {}) }) }));
    })
    .delete("/entries/:id", async (c) => {
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      return await mutate(context, cwd, async () => { await context.service.remove({ cwd, id: c.req.param("id") }); return jsonResponse({ deleted: true, id: c.req.param("id") }); });
    })
    .get("/candidates", async (c) => {
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try { return jsonResponse({ candidates: await context.service.candidates(cwd) }); }
      catch (error) { return resourceError(error); }
    })
    .post("/candidates/:id/accept", async (c) => {
      const body = await readJson(c);
      if (typeof body.cwd !== "string" || !body.cwd.trim()) return errorResponse(400, "cwd is required");
      if (body.topic !== undefined && (typeof body.topic !== "string" || !TOPICS.has(body.topic as ContextTopic))) return errorResponse(400, "invalid topic");
      return await mutate(context, body.cwd, async () => jsonResponse({ entry: await context.service.accept({ cwd: body.cwd as string, id: c.req.param("id"), ...(body.topic ? { topic: body.topic as ContextTopic } : {}) }) }));
    })
    .post("/candidates/:id/reject", async (c) => {
      const body = await readJson(c);
      if (typeof body.cwd !== "string" || !body.cwd.trim()) return errorResponse(400, "cwd is required");
      return await mutate(context, body.cwd, async () => { await context.service.reject({ cwd: body.cwd as string, id: c.req.param("id") }); return jsonResponse({ rejected: true, id: c.req.param("id") }); });
    })
    .get("/status", async (c) => {
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try { return jsonResponse(await context.service.status(cwd)); }
      catch (error) { return resourceError(error); }
    })
    .get("/preview", async (c) => {
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try { return jsonResponse(await context.service.preview(cwd, c.req.query("query") ?? "")); }
      catch (error) { return resourceError(error); }
    });
}

function readListRequest(query: Record<string, string>): { cwd: string; scope?: ContextScope; kind?: ContextKind; status?: ContextEntryStatus } | Response {
  if (!query.cwd) return errorResponse(400, "cwd is required");
  if (query.scope && !SCOPES.has(query.scope as ContextScope)) return errorResponse(400, "invalid scope");
  if (query.kind && !KINDS.has(query.kind as ContextKind)) return errorResponse(400, "invalid kind");
  return { cwd: query.cwd, ...(query.scope ? { scope: query.scope as ContextScope } : {}), ...(query.kind ? { kind: query.kind as ContextKind } : {}) };
}

interface ContextMutationControl { acquireCwdMutation(cwd: string): { release(): void } | undefined }

async function mutate(context: { control: ContextMutationControl }, cwd: string, operation: () => Promise<Response>): Promise<Response> {
  const lease = context.control.acquireCwdMutation(cwd);
  if (!lease) return errorResponse(409, "Cannot update context while session runs are active for this cwd");
  try { return await operation(); }
  catch (error) { return resourceError(error); }
  finally { lease.release(); }
}

function resourceError(error: unknown): Response {
  if (error instanceof ContextResourceError) {
    const status = error.code === "not_found" ? 404 : error.code === "secret" || error.code === "sensitive" ? 422 : 400;
    return errorResponse(status, error.message);
  }
  return errorResponse(500, error instanceof Error ? error.message : String(error));
}
