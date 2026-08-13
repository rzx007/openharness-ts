import { Hono } from "hono";

import type { DaemonCronService } from "../../daemon/index.js";
import { errorResponse, jsonResponse, readJson, readLimit } from "../support.js";

export interface CronRoutesContext {
  cron: Pick<
    DaemonCronService,
    "listJobs" | "listRuns" | "removeJob" | "saveJob" | "setEnabled" | "status" | "trigger"
  >;
}

function cronError(error: unknown, fallbackStatus = 400): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("not found") ? 404 : message.includes("already running") ? 409 : fallbackStatus;
  return errorResponse(status, message);
}

export function createCronRoutes(context: CronRoutesContext): Hono {
  return new Hono()
    .get("/status", () => jsonResponse(context.cron.status()))
    .get("/jobs", () => jsonResponse({ jobs: context.cron.listJobs() }))
    .put("/jobs/:name", async (c) => {
      const name = c.req.param("name");
      const body = await readJson(c);
      try {
        const job = context.cron.saveJob({
          name,
          expression: typeof body.expression === "string" ? body.expression : "",
          command: typeof body.command === "string" ? body.command : "",
          cwd: typeof body.cwd === "string" ? body.cwd : process.cwd(),
          timezone: typeof body.timezone === "string" ? body.timezone : undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });
        return jsonResponse({ job });
      } catch (error) {
        return cronError(error);
      }
    })
    .delete("/jobs/:name", (c) => {
      try {
        context.cron.removeJob(c.req.param("name"));
        return jsonResponse({ removed: true });
      } catch (error) {
        return cronError(error);
      }
    })
    .patch("/jobs/:name", async (c) => {
      const body = await readJson(c);
      if (typeof body.enabled !== "boolean") return errorResponse(400, "enabled must be true or false");
      try {
        return jsonResponse({ job: context.cron.setEnabled(c.req.param("name"), body.enabled) });
      } catch (error) {
        return cronError(error);
      }
    })
    .post("/jobs/:name/run", async (c) => {
      try {
        return jsonResponse({ run: await context.cron.trigger(c.req.param("name")) });
      } catch (error) {
        return cronError(error, 500);
      }
    })
    .get("/runs", (c) => {
      try {
        return jsonResponse({
          runs: context.cron.listRuns({
            name: c.req.query("name") ?? undefined,
            limit: readLimit(c.req.query("limit")),
          }),
        });
      } catch (error) {
        return cronError(error, 500);
      }
    });
}
