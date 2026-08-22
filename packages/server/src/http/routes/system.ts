import { Hono } from "hono";

import { mergeCommandCatalog, type CommandCatalogProvider } from "../../commands/index.js";
import {
  errorResponse,
  jsonResponse,
  readJson,
  type OpenHarnessServerHealth,
} from "../support.js";
import type { ModelService, ProviderService, SettingsService } from "../../application/index.js";
import { ProviderMutationError } from "../../application/default-application-services.js";
import type { DaemonControlService } from "../control/index.js";

export interface SystemRoutesContext {
  version?: string;
  commandCatalog?: CommandCatalogProvider;
  settingsService?: SettingsService;
  providerService?: ProviderService;
  modelService?: ModelService;
  control: Pick<DaemonControlService, "acquireGlobalMutation" | "closeAllRuntimes" | "runtimeSnapshot" | "inspectRun" | "listProjectionDiagnostics">;
}

export function createSystemRoutes(context: SystemRoutesContext): Hono {
  return new Hono()
    .get("/health", () => {
      const snapshot = context.control.runtimeSnapshot();
      return jsonResponse({
        ok: true,
        ...(context.version ? { version: context.version } : {}),
        startedAt: snapshot.startedAt,
        uptimeMs: snapshot.uptimeMs,
        sessionCount: snapshot.sessions.total,
        activeRunCount: snapshot.coordinator.activeRunCount,
        queuedRunCount: snapshot.coordinator.queuedRunCount,
      } satisfies OpenHarnessServerHealth);
    })
    .get("/debug/runtime", () => jsonResponse(context.control.runtimeSnapshot()))
    .get("/debug/runs/:runId", (c) => {
      const inspection = context.control.inspectRun(c.req.param("runId"), {
        includeContent: c.req.query("includeContent") === "true",
      });
      return inspection ? jsonResponse(inspection) : errorResponse(404, "Run not found");
    })
    .get("/debug/projection-settlements", (c) => jsonResponse(context.control.listProjectionDiagnostics({
      includeContent: c.req.query("includeContent") === "true",
    })))
    .get("/commands", async (c) => {
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        const extras = context.commandCatalog ? await context.commandCatalog.list({ cwd }) : [];
        return jsonResponse({ commands: mergeCommandCatalog(extras) });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/settings", async () => {
      if (!context.settingsService) return errorResponse(501, "Settings service is not configured");
      try {
        return jsonResponse({ settings: await context.settingsService.get() });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .patch("/settings", async (c) => {
      if (!context.settingsService) return errorResponse(501, "Settings service is not configured");
      const body = await readJson(c);
      const lease = context.control.acquireGlobalMutation();
      if (!lease) {
        return errorResponse(409, "Cannot update daemon settings while session runs are active");
      }
      try {
        const result = await context.settingsService.patch(body);
        if (result.restartRuntimes) await context.control.closeAllRuntimes();
        return jsonResponse({ settings: result.settings });
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : String(error));
      } finally {
        lease.release();
      }
    })
    .get("/providers", async () => {
      if (!context.providerService) return errorResponse(501, "Provider service is not configured");
      try {
        return jsonResponse({ providers: await context.providerService.list() });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/providers/custom", async (c) => {
      if (!context.providerService?.create) return errorResponse(501, "Custom provider creation is not configured");
      const lease = context.control.acquireGlobalMutation();
      if (!lease) return errorResponse(409, "Cannot update providers while session runs are active");
      try {
        const provider = await context.providerService.create(await readJson(c) as never);
        await context.control.closeAllRuntimes();
        return jsonResponse({ provider }, 201);
      } catch (error) {
        return providerMutationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .patch("/providers/custom/:id", async (c) => {
      if (!context.providerService?.update) return errorResponse(501, "Custom provider updates are not configured");
      const lease = context.control.acquireGlobalMutation();
      if (!lease) return errorResponse(409, "Cannot update providers while session runs are active");
      try {
        const provider = await context.providerService.update(c.req.param("id"), await readJson(c) as never);
        await context.control.closeAllRuntimes();
        return jsonResponse({ provider });
      } catch (error) {
        return providerMutationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .delete("/providers/custom/:id", async (c) => {
      if (!context.providerService?.remove) return errorResponse(501, "Custom provider removal is not configured");
      const lease = context.control.acquireGlobalMutation();
      if (!lease) return errorResponse(409, "Cannot update providers while session runs are active");
      try {
        await context.providerService.remove(c.req.param("id"));
        await context.control.closeAllRuntimes();
        return jsonResponse({ ok: true });
      } catch (error) {
        return providerMutationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .get("/models", async () => {
      if (!context.modelService) return errorResponse(501, "Model service is not configured");
      try {
        return jsonResponse({ providers: await context.modelService.list() });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    });
}

function providerMutationErrorResponse(error: unknown): Response {
  if (error instanceof ProviderMutationError) return errorResponse(error.status, error.message);
  return errorResponse(400, error instanceof Error ? error.message : String(error));
}
