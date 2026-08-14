import { stat } from "node:fs/promises";

import type { SessionStore } from "@openharness/services";
import { Hono } from "hono";

import { errorResponse, jsonResponse, readJson } from "../support.js";

export function createProjectRoutes(store: SessionStore): Hono {
  return new Hono()
    .get("/", (c) =>
      jsonResponse({
        projects: store.listProjects({
          includeArchived: c.req.query("includeArchived") === "true",
        }),
      }),
    )
    .post("/inspect", async (c) => {
      const body = await readJson(c);
      if (typeof body.path !== "string")
        return errorResponse(400, "path is required");
      try {
        if (!(await stat(body.path)).isDirectory())
          return errorResponse(400, "path is not a directory");
        return jsonResponse({ project: store.inspectProject(body.path) });
      } catch (error) {
        return errorResponse(
          400,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .patch("/:projectId", async (c) => {
      const body = await readJson(c);
      try {
        const project =
          typeof body.name === "string"
            ? store.renameProject(c.req.param("projectId"), body.name)
            : typeof body.pinned === "boolean"
              ? store.setProjectPinned(c.req.param("projectId"), body.pinned)
              : null;
        return project
          ? jsonResponse({ project })
          : errorResponse(400, "name or pinned is required");
      } catch (error) {
        return errorResponse(
          404,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .post("/:projectId/rebind", async (c) => {
      const body = await readJson(c);
      if (typeof body.path !== "string")
        return errorResponse(400, "path is required");
      try {
        if (!(await stat(body.path)).isDirectory())
          return errorResponse(400, "path is not a directory");
        return jsonResponse({
          project: store.rebindProject(c.req.param("projectId"), body.path),
        });
      } catch (error) {
        return errorResponse(
          400,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .delete("/:projectId", (c) => {
      try {
        return jsonResponse({
          project: store.archiveProject(c.req.param("projectId")),
        });
      } catch (error) {
        return errorResponse(
          404,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
}
