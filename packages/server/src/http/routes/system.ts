import { Hono } from "hono";

import { mergeCommandCatalog, type CommandCatalogProvider } from "../../commands.js";
import {
  errorResponse,
  jsonResponse,
  readJson,
  type OpenHarnessServerHealth,
} from "../support.js";
import type { ProviderService, SettingsService } from "../../settings-api.js";
import type { DaemonControlService } from "../daemon-control-service.js";

export interface SystemRoutesContext {
  version?: string;
  commandCatalog?: CommandCatalogProvider;
  settingsService?: SettingsService;
  providerService?: ProviderService;
  control: Pick<DaemonControlService, "closeAllRuntimes" | "hasAnyActiveRuns" | "runtimeSnapshot">;
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
      if (context.control.hasAnyActiveRuns()) {
        return errorResponse(409, "Cannot update daemon settings while session runs are active");
      }
      const body = await readJson(c);
      try {
        const result = await context.settingsService.patch(body);
        if (result.restartRuntimes) await context.control.closeAllRuntimes();
        return jsonResponse({ settings: result.settings });
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/providers", async () => {
      if (!context.providerService) return errorResponse(501, "Provider service is not configured");
      try {
        return jsonResponse({ providers: await context.providerService.list() });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    });
}
