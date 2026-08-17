import { Hono } from "hono";

import type { JobStatus } from "@openharness/jobs";

import type { DaemonJobService } from "../../jobs/index.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

export function createJobRoutes(jobs: DaemonJobService): Hono {
  return new Hono()
    .get("/", async (c) => {
      try {
        const sessionId = required(c.req.query("sessionId"), "sessionId");
        const status = readStatus(c.req.query("status"));
        return jsonResponse({ jobs: await jobs.list({ sessionId, ...(status ? { status } : {}) }) });
      } catch (error) {
        return jobError(error);
      }
    })
    .get("/:jobId", async (c) => {
      try {
        return jsonResponse(await jobs.read({
          sessionId: required(c.req.query("sessionId"), "sessionId"),
          jobId: c.req.param("jobId"),
          after: optionalNumber(c.req.query("after")),
          maxChars: optionalNumber(c.req.query("maxChars")),
        }));
      } catch (error) {
        return jobError(error);
      }
    })
    .post("/:jobId/wait", async (c) => {
      const body = await readJson(c);
      try {
        return jsonResponse(await jobs.wait({
          sessionId: required(body.sessionId, "sessionId"),
          jobId: c.req.param("jobId"),
          timeoutMs: numberValue(body.timeoutMs, 30_000),
          after: numberOrUndefined(body.after),
          maxChars: numberOrUndefined(body.maxChars),
        }));
      } catch (error) {
        return jobError(error);
      }
    })
    .post("/:jobId/input", async (c) => {
      const body = await readJson(c);
      try {
        await jobs.send({
          sessionId: required(body.sessionId, "sessionId"),
          jobId: c.req.param("jobId"),
          data: typeof body.data === "string" ? body.data : "",
        });
        return jsonResponse({ sent: true });
      } catch (error) {
        return jobError(error);
      }
    })
    .post("/:jobId/cancel", async (c) => {
      const body = await readJson(c);
      try {
        return jsonResponse({ snapshot: await jobs.cancel({
          sessionId: required(body.sessionId, "sessionId"),
          jobId: c.req.param("jobId"),
          ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        }) });
      } catch (error) {
        return jobError(error);
      }
    });
}

function jobError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return errorResponse(message.includes("not found") || message.includes("not exist") ? 404 : 400, message);
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function readStatus(value: unknown): JobStatus | undefined {
  return value === "running" || value === "stopping" || value === "completed" || value === "killed" || value === "failed"
    ? value
    : undefined;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return numberOrUndefined(value) ?? fallback;
}
