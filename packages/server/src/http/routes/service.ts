import { Hono } from "hono";

import { errorResponse, jsonResponse, readJson } from "../support.js";
import type {
  AgentPersonaService,
  DreamService,
  HooksService,
  OutputStyleService,
  PluginService,
  ProfileService,
  ProjectInitService,
} from "../../application/index.js";
import type { DaemonControlService } from "../../application/control/index.js";

export interface ServiceRoutesContext {
  dreamService?: DreamService;
  profileService?: ProfileService;
  outputStyleService?: OutputStyleService;
  projectInitService?: ProjectInitService;
  pluginService?: PluginService;
  agentPersonaService?: AgentPersonaService;
  hooksService?: HooksService;
  control: Pick<
    DaemonControlService,
    | "closeAllRuntimes"
    | "closeRuntimesForCwd"
    | "acquireCwdMutation"
    | "acquireGlobalMutation"
    | "inspectRuntimeHooks"
    | "runtimeInspectionAvailable"
    | "sessionExists"
  >;
}

export function createServiceRoutes(context: ServiceRoutesContext): Hono {
  return new Hono()
    .post("/dream", async (c) => {
      if (!context.dreamService) return errorResponse(501, "Dream service is not configured");
      const body = await readJson(c);
      if (typeof body.cwd !== "string" || !body.cwd.trim()) {
        return errorResponse(400, "cwd is required");
      }
      try {
        const result = await context.dreamService.start({
          cwd: body.cwd,
          sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
          preview: body.preview === true,
        });
        if (!result.started) {
          return errorResponse(409, result.reason ?? "Dream was not started");
        }
        return jsonResponse({ taskId: result.taskId }, 201);
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/profile", async () => {
      if (!context.profileService) return errorResponse(501, "Profile service is not configured");
      try {
        return jsonResponse(await context.profileService.status());
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/profile/init", async () => {
      if (!context.profileService) return errorResponse(501, "Profile service is not configured");
      const lease = context.control.acquireGlobalMutation();
      if (!lease) {
        return errorResponse(409, "Cannot initialize profile while session runs are active");
      }
      try {
        const result = await context.profileService.init();
        await context.control.closeAllRuntimes();
        return jsonResponse(result);
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      } finally {
        lease.release();
      }
    })
    .get("/output-styles", async () => {
      if (!context.outputStyleService) return errorResponse(501, "Output style service is not configured");
      try {
        return jsonResponse({ styles: await context.outputStyleService.list() });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/project/init", async (c) => {
      if (!context.projectInitService) return errorResponse(501, "Project init service is not configured");
      const body = await readJson(c);
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(await context.projectInitService.init({ cwd }));
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/plugins", async (c) => {
      if (!context.pluginService) return errorResponse(501, "Plugin service is not configured");
      const cwd = c.req.query("cwd") ?? undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(await context.pluginService.list({ cwd }));
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/plugins/install-local", (c) => installLocalPlugin(context, c, false))
    .post("/plugins/link-local", (c) => installLocalPlugin(context, c, true))
    .post("/plugins/:id/enable", async (c) => setPluginEnabled(context, c.req.param("id"), true, await readJson(c)))
    .post("/plugins/:id/disable", async (c) => setPluginEnabled(context, c.req.param("id"), false, await readJson(c)))
    .delete("/plugins/:id", async (c) => {
      if (!context.pluginService?.uninstall) return errorResponse(501, "Plugin uninstall is not configured");
      const body = await readJson(c);
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      const lease = context.control.acquireCwdMutation(cwd);
      if (!lease) return errorResponse(409, "Cannot uninstall plugins while session runs are active for this cwd");
      try {
        const result = await context.pluginService.uninstall({ cwd, id: c.req.param("id") });
        if (result.restartRuntimes) await context.control.closeRuntimesForCwd(cwd);
        return jsonResponse({ message: result.message });
      } catch (error) { return errorResponse(400, error instanceof Error ? error.message : String(error)); }
      finally { lease.release(); }
    })
    .post("/plugins/reload", async (c) => {
      if (!context.pluginService) return errorResponse(501, "Plugin service is not configured");
      const body = await readJson(c);
      const cwd = typeof body.cwd === "string" ? body.cwd : c.req.query("cwd") ?? undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      const lease = context.control.acquireCwdMutation(cwd);
      if (!lease) {
        return errorResponse(409, "Cannot reload plugins while session runs are active for this cwd");
      }
      try {
        await context.control.closeRuntimesForCwd(cwd);
        const listed = await context.pluginService.list({ cwd });
        return jsonResponse({
          ...listed,
          message: "Plugins rediscovered; session runtimes will reload on next use.",
        });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      } finally {
        lease.release();
      }
    })
    .get("/agent-personas", async () => {
      if (!context.agentPersonaService) return errorResponse(501, "Agent persona service is not configured");
      try {
        return jsonResponse(await context.agentPersonaService.list());
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/hooks", async (c) => {
      if (!context.hooksService) return errorResponse(501, "Hooks service is not configured");
      const cwd = c.req.query("cwd") ?? undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      const sessionId = c.req.query("sessionId") ?? undefined;
      try {
        const listed = await context.hooksService.list({ cwd, ...(sessionId ? { sessionId } : {}) });
        const hooks = [...listed.hooks];
        if (sessionId && context.control.runtimeInspectionAvailable) {
          if (!context.control.sessionExists(sessionId)) {
            return errorResponse(404, "Session not found");
          }
          for (const hook of await context.control.inspectRuntimeHooks(sessionId)) {
            if (!hooks.some((row) => row.id === hook.id && row.origin === hook.origin)) {
              hooks.push(hook);
            }
          }
        }
        return jsonResponse({ hooks });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    });
}

async function setPluginEnabled(
  context: ServiceRoutesContext,
  id: string,
  enabled: boolean,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!context.pluginService) return errorResponse(501, "Plugin service is not configured");
  if (!id) return errorResponse(400, "plugin id is required");
  const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
  if (!cwd) return errorResponse(400, "cwd is required");
  const lease = context.control.acquireCwdMutation(cwd);
  if (!lease) {
    return errorResponse(409, "Cannot update plugins while session runs are active");
  }
  try {
    const result = await context.pluginService.setEnabled({ id, cwd, enabled });
    if (result.restartRuntimes) await context.control.closeRuntimesForCwd(cwd);
    return jsonResponse({ message: result.message });
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : String(error));
  } finally {
    lease.release();
  }
}

async function installLocalPlugin(context: ServiceRoutesContext, c: any, link: boolean): Promise<Response> {
  if (!context.pluginService?.installLocal) return errorResponse(501, "Plugin installation is not configured");
  const body = await readJson(c);
  const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
  const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath : undefined;
  const scope = body.scope;
  const approvedPermissions = Array.isArray(body.approvedPermissions)
    ? body.approvedPermissions.filter((item): item is string => typeof item === "string") : [];
  if (!cwd || !sourcePath || (scope !== "user" && scope !== "project" && scope !== "local")) {
    return errorResponse(400, "cwd, sourcePath and valid scope are required");
  }
  const lease = context.control.acquireCwdMutation(cwd);
  if (!lease) return errorResponse(409, "Cannot install plugins while session runs are active for this cwd");
  try {
    const result = await context.pluginService.installLocal({ cwd, sourcePath, scope, approvedPermissions, link });
    if (result.restartRuntimes) await context.control.closeRuntimesForCwd(cwd);
    return jsonResponse({ message: result.message });
  } catch (error) { return errorResponse(400, error instanceof Error ? error.message : String(error)); }
  finally { lease.release(); }
}
