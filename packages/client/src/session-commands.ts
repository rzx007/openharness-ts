import type { OpenHarnessClient } from "./client.js";
import type { CommandCatalogEntry, OpenHarnessClientState } from "./types.js";

export type SlashLine = { name: string; args: string };

export type SessionCommandHost = {
  client: OpenHarnessClient;
  sessionId?: string;
  /** Project cwd for memory/git/plugins/etc. */
  cwd: string;
  /** Values used by /status /model show */
  model?: string;
  permissionMode?: string;
  statusSessionId?: string;
  commandCatalog: CommandCatalogEntry[];
  clientState: OpenHarnessClientState;
  busy: boolean;
  /** Present a system/notice message to the user */
  emit(text: string): void;
  /** Optional status patch for /plan /model /provider */
  patchStatus?(patch: Record<string, unknown>): void;
};

export type SessionCommandOutcome =
  | "handled"
  | "unhandled"
  | "local_ui";

/** Client-local UI commands; never forwarded as model prompts. */
export const LOCAL_COMMAND_DETAILS: Array<{ name: string; description?: string }> = [
  { name: "/new", description: "Start a new session" },
  { name: "/sessions", description: "List and switch sessions" },
  { name: "/resume", description: "Replay an interrupted prompt run" },
  { name: "/permissions", description: "Change permission mode" },
  { name: "/plan", description: "Toggle plan mode" },
  { name: "/theme", description: "Change TUI theme" },
  { name: "/workflow", description: "Open workflow runs panel" },
  { name: "/workflows", description: "Open workflow runs panel" },
];

export const LOCAL_COMMAND_NAMES = new Set(LOCAL_COMMAND_DETAILS.map((entry) => entry.name));

export function parseSlashLine(line: string): SlashLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return { name: trimmed, args: "" };
  return { name: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() };
}

export function mergeCommandDetails(
  catalog: CommandCatalogEntry[],
): Array<{ name: string; description?: string }> {
  const byName = new Map<string, { name: string; description?: string }>();
  for (const entry of LOCAL_COMMAND_DETAILS) byName.set(entry.name, entry);
  for (const entry of catalog) {
    if (byName.has(entry.name)) continue;
    byName.set(entry.name, {
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function hasActiveRun(state: OpenHarnessClientState, sessionId?: string): boolean {
  if (!sessionId) return false;
  const bucket = state.buckets[sessionId];
  if (!bucket) return false;
  return Object.values(bucket.runs).some((run) => run.status === "pending" || run.status === "running");
}

export function resolveSessionCwd(input: {
  statusCwd?: unknown;
  daemonCwd?: string;
  fallback?: string;
}): string {
  if (typeof input.statusCwd === "string" && input.statusCwd) return input.statusCwd;
  if (input.daemonCwd) return input.daemonCwd;
  return input.fallback ?? (typeof process !== "undefined" ? process.cwd() : ".");
}

export async function dispatchSessionCommand(
  slash: SlashLine | null,
  host: SessionCommandHost,
): Promise<SessionCommandOutcome> {
  const {
    client,
    sessionId,
    cwd,
    model,
    permissionMode,
    statusSessionId,
    commandCatalog,
    clientState,
    busy,
  } = host;
  const emit = (text: string) => host.emit(text);
  const patchStatus = (patch: Record<string, unknown>) => host.patchStatus?.(patch);

  if (slash?.name === "/plan") {
    const next =
      slash.args === "on" ? "plan"
        : slash.args === "off" ? "default"
          : undefined;
    if (!next) {
      emit("Usage: /plan [on|off]");
      return "handled";
    }
    patchStatus({ permission_mode: next });
    if (sessionId) {
      const current = await client.getSession(sessionId);
      await client.updateSession(sessionId, {
        metadata: { ...current.metadata, permissionMode: next },
      });
    }
    emit(`Permission mode: ${next}`);
    return "handled";
  }

  if (slash?.name === "/model") {
    if (!sessionId) return "handled";
    if (!slash.args) {
      emit(`Model: ${model ?? "default"}`);
      return "handled";
    }
    const session = await client.updateSession(sessionId, { model: slash.args });
    patchStatus({ model: session.model });
    emit(`Model set to ${session.model}`);
    return "handled";
  }

  if (slash?.name === "/skills") {
    const templates = commandCatalog.filter((entry) => entry.kind === "template");
    if (slash.args) {
      const name = slash.args.startsWith("/") ? slash.args : `/${slash.args}`;
      const match = templates.find((entry) => entry.name === name || entry.name === `/${slash.args}`);
      if (!match) {
        emit(`Unknown skill: ${slash.args}`);
        return "handled";
      }
      emit(`${match.name}${match.description ? ` — ${match.description}` : ""}`);
      return "handled";
    }
    if (templates.length === 0) {
      emit("No user-invocable skills available.");
      return "handled";
    }
    emit(
      ["Skills:", ...templates.map((entry) =>
        `- ${entry.name}${entry.description ? ` — ${entry.description}` : ""}`)].join("\n"),
    );
    return "handled";
  }

  if (slash?.name === "/help") {
    const details = mergeCommandDetails(commandCatalog);
    emit(
      ["Available commands:", ...details.map((entry) =>
        `${entry.name}${entry.description ? ` — ${entry.description}` : ""}`)].join("\n"),
    );
    return "handled";
  }

  if (slash?.name === "/version") {
    const health = await client.health();
    emit(`OpenHarness${health.version ? ` v${health.version}` : ""}`);
    return "handled";
  }

  if (slash?.name === "/status") {
    emit([
      "Session status:",
      `  session: ${statusSessionId ?? "(none)"}`,
      `  model:   ${model ?? "(unknown)"}`,
      `  cwd:     ${cwd || "(unknown)"}`,
      `  mode:    ${permissionMode ?? "default"}`,
      `  busy:    ${busy || hasActiveRun(clientState, sessionId) ? "yes" : "no"}`,
    ].join("\n"));
    return "handled";
  }

  if (slash?.name === "/config") {
    const args = slash.args.trim();
    if (!args || args === "show") {
      const settings = await client.getSettings();
      emit(JSON.stringify(settings, null, 2));
      return "handled";
    }
    const setMatch = args.match(/^set\s+(\S+)\s+([\s\S]+)$/);
    if (!setMatch?.[1] || setMatch[2] === undefined) {
      emit("Usage: /config [show | set KEY VALUE]");
      return "handled";
    }
    await client.patchSettings({ path: setMatch[1], value: setMatch[2].trim() });
    emit(`Set ${setMatch[1]} = ${setMatch[2].trim()}`);
    return "handled";
  }

  if (slash?.name === "/provider") {
    if (!slash.args) {
      const providers = await client.listProviders();
      const lines = ["Available providers:", ""];
      for (const provider of providers) {
        const marker = provider.active ? " (active)" : "";
        const keyStatus = provider.local ? "[local]" : provider.hasKey ? "[key]" : "[no key]";
        lines.push(`  ${provider.name.padEnd(14)} ${provider.displayName.padEnd(14)} ${keyStatus}${marker}`);
      }
      emit(lines.join("\n"));
      return "handled";
    }
    const settings = await client.patchSettings(
      slash.args === "auto"
        ? { provider: "auto" }
        : { provider: slash.args },
    );
    if (typeof settings.model === "string") {
      patchStatus({ model: settings.model });
    }
    emit(`Provider switched to: ${slash.args}`);
    return "handled";
  }

  if (slash?.name === "/mcp") {
    if (!sessionId) return "handled";
    const servers = await client.getSessionMcp(sessionId);
    if (servers.length === 0) {
      emit("No MCP servers connected.");
      return "handled";
    }
    emit(
      [
        `MCP Servers (${servers.length}):`,
        "",
        ...servers.flatMap((server) => [
          `  ${server.name}: ${server.status}`,
          ...(server.command ? [`    Command: ${server.command}`] : []),
          `    Tools: ${server.toolCount}  Resources: ${server.resourceCount}`,
          ...(server.error ? [`    Error: ${server.error}`] : []),
          "",
        ]),
      ].join("\n"),
    );
    return "handled";
  }

  if (slash?.name === "/tasks") {
    if (!sessionId) return "handled";
    const args = slash.args.trim();
    const [sub, id] = args.split(/\s+/).filter(Boolean);
    if (!sub || sub === "list") {
      const tasks = await client.listTasks({ sessionId });
      if (tasks.length === 0) {
        emit("No tasks.");
        return "handled";
      }
      emit(
        [
          `Tasks (${tasks.length}):`,
          "",
          ...tasks.map((task) => `  ${task.id} [${task.status}] ${task.type}: ${task.description}`),
        ].join("\n"),
      );
      return "handled";
    }
    if (sub === "show" && id) {
      const detail = await client.getTask(id, { sessionId });
      emit([
        `Task: ${detail.task.id}`,
        `  Type:        ${detail.task.type}`,
        `  Status:      ${detail.task.status}`,
        `  Description: ${detail.task.description}`,
        `  CWD:         ${detail.task.cwd}`,
        `  Command:     ${detail.task.command ?? "(none)"}`,
        `  Exit code:   ${detail.task.exitCode ?? "(n/a)"}`,
        "",
        "Output:",
        detail.output ?? "(no output)",
      ].join("\n"));
      return "handled";
    }
    if (sub === "stop" && id) {
      const task = await client.stopTask(id, { sessionId });
      emit(`Task ${task.id} stopped.`);
      return "handled";
    }
    if (sub === "run") {
      const command = args.replace(/^run\s+/i, "").trim();
      if (!command) {
        emit("Usage: /tasks run <command>");
        return "handled";
      }
      const task = await client.createTask({ sessionId, command });
      emit(`Task started: ${task.id} — ${command}`);
      return "handled";
    }
    emit("Usage: /tasks [list | show ID | stop ID | run CMD]");
    return "handled";
  }

  if (slash?.name === "/memory") {
    const args = slash.args.trim();
    const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
    if (!sub || sub === "list") {
      const listed = await client.listMemory({ cwd });
      if (listed.entries.length === 0) {
        emit(`Memory directory: ${listed.directory}\nNo entries found.`);
        return "handled";
      }
      emit(
        [
          `Memory entries (${listed.entries.length}):`,
          "",
          ...listed.entries.map((entry) => {
            const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
            const preview = entry.content.length > 80
              ? `${entry.content.slice(0, 80)}...`
              : entry.content;
            return `  ${entry.id}${tags}: ${preview}`;
          }),
        ].join("\n"),
      );
      return "handled";
    }
    if (sub === "show" && rest[0]) {
      const entry = await client.getMemory(rest[0], { cwd });
      emit([
        `ID:       ${entry.id}`,
        `Created:  ${new Date(entry.createdAt).toISOString()}`,
        `Updated:  ${new Date(entry.updatedAt).toISOString()}`,
        `Tags:     ${entry.tags?.join(", ") ?? "(none)"}`,
        "",
        entry.content,
      ].join("\n"));
      return "handled";
    }
    if (sub === "add") {
      const content = rest.join(" ").trim();
      if (!content) {
        emit("Usage: /memory add <content>");
        return "handled";
      }
      const entry = await client.addMemory({ cwd, content });
      emit(`Memory added: ${entry.id}`);
      return "handled";
    }
    if (sub === "remove" && rest[0]) {
      await client.removeMemory(rest[0], { cwd });
      emit(`Memory removed: ${rest[0]}`);
      return "handled";
    }
    emit("Usage: /memory [list | show ID | add CONTENT | remove ID]");
    return "handled";
  }

  if (slash?.name === "/auth") {
    const args = slash.args.trim();
    const [sub, provider, apiKey] = args.split(/\s+/).filter(Boolean);
    if (!sub || sub === "status") {
      const auth = await client.getAuthStatus();
      const lines = ["Credential status:", "", "  Auth sources:"];
      lines.push(
        `    codex_subscription: ${auth.codex.configured ? "ready" : auth.codex.state} (${auth.codex.source})`,
      );
      if (auth.storedProviders.length > 0) {
        lines.push("", "  Stored credentials:");
        for (const name of auth.storedProviders) lines.push(`    ${name}: configured`);
      }
      if (auth.envProviders.length > 0) {
        lines.push("  Environment variables:");
        for (const env of auth.envProviders) lines.push(`    ${env.name}: ${env.envKey}`);
      }
      if (auth.storedProviders.length === 0 && auth.envProviders.length === 0) {
        lines.push("", "  No credentials configured.");
        lines.push("  Use /auth login <provider> <api-key> to store an API key.");
        lines.push("  Use /auth login codex to use a Codex subscription.");
      }
      emit(lines.join("\n"));
      return "handled";
    }
    if (sub === "login") {
      if (!provider) {
        emit("Usage: /auth login <provider> <api-key> or /auth login codex");
        return "handled";
      }
      const result = await client.authLogin({ provider, apiKey });
      emit(result.message);
      return "handled";
    }
    if (sub === "logout") {
      if (!provider) {
        emit("Usage: /auth logout <provider>");
        return "handled";
      }
      const result = await client.authLogout({ provider });
      emit(result.message);
      return "handled";
    }
    emit("Unknown subcommand. Use login, logout, or status.");
    return "handled";
  }

  if (slash?.name === "/context") {
    const report = await client.getContextPreview({ cwd });
    emit(report);
    return "handled";
  }

  if (slash?.name === "/stats") {
    if (!sessionId) return "handled";
    const bucket = clientState.buckets[sessionId];
    const messageCount = bucket?.messages.length ?? 0;
    const text = (bucket?.messages ?? [])
      .flatMap((message) => bucket?.partsByMessageId[message.id] ?? [])
      .map((part) => part.text ?? "")
      .join(" ");
    const estimatedTokens = Math.max(1, Math.ceil(text.length / 4));
    const [memory, tasks, settings] = await Promise.all([
      client.listMemory({ cwd }).catch(() => ({ entries: [] as Array<{ id: string }> })),
      client.listTasks({ sessionId }).catch(() => []),
      client.getSettings().catch(() => ({} as Record<string, unknown>)),
    ]);
    emit([
      "Session stats:",
      `- messages: ${messageCount}`,
      `- estimated_tokens: ${estimatedTokens}`,
      `- memory_entries: ${memory.entries.length}`,
      `- background_tasks: ${tasks.length}`,
      `- output_style: ${typeof settings.outputStyle === "string" ? settings.outputStyle : "default"}`,
    ].join("\n"));
    return "handled";
  }

  if (slash?.name === "/agents") {
    if (!sessionId) return "handled";
    const tasks = await client.listTasks({ sessionId });
    const agents = tasks.filter((task) => task.type === "agent");
    if (agents.length === 0) {
      emit("No agent tasks.");
      return "handled";
    }
    emit(
      [
        `Agent tasks (${agents.length}):`,
        "",
        ...agents.map((task) => `  ${task.id} [${task.status}] ${task.description}`),
      ].join("\n"),
    );
    return "handled";
  }

  if (slash?.name === "/rewind") {
    if (!sessionId) return "handled";
    const raw = slash.args.trim().split(/\s+/).filter(Boolean)[0] ?? "1";
    const count = Number.parseInt(raw, 10);
    if (!Number.isInteger(count) || count < 1) {
      emit("Count must be a positive integer");
      return "handled";
    }
    const result = await client.rewindSession(sessionId, { count });
    emit(`Rewound ${result.turns} turn(s), removed ${result.removed} message(s).`);
    return "handled";
  }

  if (slash?.name === "/compact") {
    if (!sessionId) return "handled";
    const result = await client.compactSession(sessionId);
    emit(`Conversation compacted (${result.messageCount} messages retained).`);
    return "handled";
  }

  if (slash?.name === "/remember") {
    if (!sessionId) return "handled";
    const result = await client.rememberSession(sessionId);
    if (result.skipped) {
      emit(`未写入记忆:${result.reason ?? "skipped"}`);
      return "handled";
    }
    emit(`已写入 ${result.writtenIds.length} 条记忆:${result.titles.join("、")}`);
    return "handled";
  }

  if (slash?.name === "/dream") {
    const preview = slash.args.includes("--preview");
    const result = await client.startDream({
      cwd,
      ...(sessionId ? { sessionId } : {}),
      preview,
    });
    emit(`Dream 已启动(task ${result.taskId})。用 /tasks 观察进度。`);
    return "handled";
  }

  if (slash?.name === "/profile") {
    const action = slash.args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
    if (action === "status" || action === "show") {
      emit(await client.getProfileStatus());
      return "handled";
    }
    if (action === "init") {
      emit(await client.initProfile());
      return "handled";
    }
    emit("Usage: /profile [status|init]");
    return "handled";
  }

  if (slash?.name === "/doctor") {
    const [settings, auth, memory, mcp, tasks] = await Promise.all([
      client.getSettings().catch(() => ({}) as Record<string, unknown>),
      client.getAuthStatus().catch(() => null),
      client.listMemory({ cwd }).catch(() => ({ directory: "(unavailable)", entries: [] as Array<{ id: string }> })),
      sessionId ? client.getSessionMcp(sessionId).catch(() => []) : Promise.resolve([]),
      sessionId ? client.listTasks({ sessionId }).catch(() => []) : Promise.resolve([]),
    ]);
    const bucket = sessionId ? clientState.buckets[sessionId] : undefined;
    const lines = [
      "OpenHarness Environment Diagnostic",
      "═".repeat(40),
      "",
      `CWD:            ${cwd}`,
      `Node:           ${process.version}`,
      `Platform:       ${process.platform} ${process.arch}`,
      `Model:          ${model ?? String(settings.model ?? "(unknown)")}`,
      `API Format:     ${String(settings.apiFormat ?? "(default)")}`,
      `Base URL:       ${String(settings.baseUrl ?? "(default)")}`,
      `Permission:     ${typeof settings.permission === "object" && settings.permission && "mode" in settings.permission
        ? String((settings.permission as { mode?: string }).mode ?? "default")
        : "default"}`,
      `Max Turns:      ${String(settings.maxTurns ?? "(default)")}`,
      `Effort:         ${String(settings.effort ?? "medium")}`,
      `Passes:         ${String(settings.passes ?? 1)}`,
      `Fast Mode:      ${settings.fastMode ? "on" : "off"}`,
      `Theme:          ${String(settings.theme ?? "default")}`,
      "",
      `Messages:       ${bucket?.messages.length ?? 0}`,
      `Background tasks: ${tasks.length}`,
      "",
      `Memory dir:     ${memory.directory}`,
      `Memory entries: ${memory.entries.length}`,
    ];
    if (auth) {
      lines.push(
        "",
        `Codex auth:     ${auth.codex.configured ? "ready" : auth.codex.state} (${auth.codex.source})`,
        `Stored keys:    ${auth.storedProviders.length ? auth.storedProviders.join(", ") : "(none)"}`,
      );
    }
    lines.push("", "MCP Servers:");
    if (mcp.length === 0) lines.push("  (none)");
    else {
      for (const server of mcp) {
        lines.push(`  ${server.name}: ${server.status} (${server.toolCount} tools)`);
      }
    }
    emit(lines.join("\n"));
    return "handled";
  }

  if (slash?.name === "/effort") {
    const level = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    if (!level) {
      const settings = await client.getSettings();
      emit(`Current effort: ${String(settings.effort ?? "medium")}`);
      return "handled";
    }
    if (level !== "low" && level !== "medium" && level !== "high") {
      emit("Invalid effort. Use: low, medium, or high");
      return "handled";
    }
    await client.patchSettings({ effort: level });
    emit(`Effort set to: ${level}`);
    return "handled";
  }

  if (slash?.name === "/fast") {
    const arg = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    const settings = await client.getSettings();
    const current = settings.fastMode === true;
    let next: boolean;
    if (arg === "on") next = true;
    else if (arg === "off") next = false;
    else next = !current;
    await client.patchSettings({ fastMode: next });
    emit(`Fast mode: ${next ? "ON" : "OFF"}`);
    return "handled";
  }

  if (slash?.name === "/turns") {
    const value = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    if (!value) {
      const settings = await client.getSettings();
      emit(`Current max turns: ${String(settings.maxTurns ?? "(default)")}`);
      return "handled";
    }
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 512) {
      emit("Value must be between 1 and 512");
      return "handled";
    }
    await client.patchSettings({ maxTurns: n });
    emit(`Max turns set to: ${n}`);
    return "handled";
  }

  if (slash?.name === "/usage" || slash?.name === "/cost") {
    if (!sessionId) return "handled";
    const usage = await client.getSessionUsage(sessionId);
    if (slash.name === "/cost") {
      emit([
        "Cost estimate:",
        `  Model:         ${usage.model}`,
        `  Input tokens:  ${usage.inputTokens.toLocaleString()}`,
        `  Output tokens: ${usage.outputTokens.toLocaleString()}`,
        `  Est. cost:     ${usage.estimatedCost}`,
        ...(usage.cacheCreationTokens
          ? [`  Cache write:   ${usage.cacheCreationTokens.toLocaleString()}`]
          : []),
        ...(usage.cacheReadTokens
          ? [`  Cache read:    ${usage.cacheReadTokens.toLocaleString()}`]
          : []),
      ].join("\n"));
      return "handled";
    }
    emit([
      "Token usage:",
      `  Input:         ${usage.inputTokens.toLocaleString()}`,
      `  Output:        ${usage.outputTokens.toLocaleString()}`,
      `  Total:         ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
      `  Cache write:   ${usage.cacheCreationTokens.toLocaleString()}`,
      `  Cache read:    ${usage.cacheReadTokens.toLocaleString()}`,
      `  Messages:      ${usage.messageCount}`,
      `  Est. cost:     ${usage.estimatedCost}`,
    ].join("\n"));
    return "handled";
  }

  if (slash?.name === "/export") {
    if (!sessionId) return "handled";
    const args = slash.args.trim().split(/\s+/).filter(Boolean);
    const forceJson = args.includes("--json");
    const filename = args.find((arg) => !arg.startsWith("--"));
    const result = await client.exportSession(sessionId, {
      ...(filename ? { filename } : {}),
      json: forceJson,
    });
    emit(`Exported ${result.format === "json" ? "JSON" : "Markdown"} to: ${result.filepath}`);
    return "handled";
  }

  if (slash?.name === "/output-style") {
    const args = slash.args.trim();
    const styles = await client.listOutputStyles();
    const settings = await client.getSettings();
    const current = typeof settings.outputStyle === "string" ? settings.outputStyle : "default";
    const firstSpace = args.search(/\s/);
    const first = firstSpace === -1 ? args : args.slice(0, firstSpace);
    const rest = firstSpace === -1 ? "" : args.slice(firstSpace + 1).trim();

    if (!first || first === "show") {
      emit(`Output style: ${current}`);
      return "handled";
    }
    if (first === "list") {
      emit(
        styles
          .map((style) => `${style.name === current ? "* " : "  "}${style.name} [${style.source}]`)
          .join("\n"),
      );
      return "handled";
    }

    const styleName = first === "set" && rest ? rest : rest === "" ? first : undefined;
    if (!styleName) {
      emit("Usage: /output-style [show|list|NAME]");
      return "handled";
    }
    if (!styles.some((style) => style.name === styleName)) {
      emit(`Unknown output style: ${styleName}`);
      return "handled";
    }
    await client.patchSettings({ outputStyle: styleName });
    emit(`Output style set to ${styleName}`);
    return "handled";
  }

  if (slash?.name === "/init") {
    emit(await client.initProject({ cwd }));
    return "handled";
  }

  if (slash?.name === "/plugin") {
    const args = slash.args.trim().split(/\s+/).filter(Boolean);
    const sub = args[0];
    if (!sub || sub === "list") {
      const listed = await client.listPlugins({ cwd });
      if (listed.plugins.length === 0) {
        emit("No plugins discovered.");
        return "handled";
      }
      emit(
        [
          ...listed.plugins.map(
            (plugin) =>
              `- ${plugin.name}@${plugin.version} [${plugin.enabled ? "enabled" : "disabled"}] ` +
              `skills=${plugin.skillCount} commands=${plugin.commandCount} hooks=${plugin.hookCount} agents=${plugin.agentCount}`,
          ),
          ...listed.warnings.map((warning) => `! ${warning}`),
        ].join("\n"),
      );
      return "handled";
    }
    if ((sub === "enable" || sub === "disable") && args[1]) {
      const result = sub === "enable"
        ? await client.enablePlugin(args[1])
        : await client.disablePlugin(args[1]);
      emit(result.message);
      return "handled";
    }
    emit("Usage: /plugin [list|enable NAME|disable NAME]");
    return "handled";
  }

  if (slash?.name === "/reload-plugins") {
    const result = await client.reloadPlugins({ cwd });
    if (result.plugins.length === 0) {
      emit(`${result.message}\nNo plugins discovered.`);
      return "handled";
    }
    emit(
      [
        result.message,
        "Reloaded plugins:",
        ...result.plugins.map(
          (plugin) => `- ${plugin.name} [${plugin.enabled ? "enabled" : "disabled"}]`,
        ),
        ...result.warnings.map((warning) => `! ${warning}`),
      ].join("\n"),
    );
    return "handled";
  }

  if (slash?.name === "/hooks") {
    const hooks = await client.listHooks({
      cwd,
      ...(sessionId ? { sessionId } : {}),
    });
    if (hooks.length === 0) {
      emit("No hooks configured.");
      return "handled";
    }
    const settingsHooks = hooks.filter((hook) => hook.origin === "settings");
    const runtimeHooks = hooks.filter((hook) => hook.origin === "runtime");
    const lines = ["Hooks:", ""];
    if (runtimeHooks.length > 0) {
      lines.push("Runtime hooks:");
      for (const hook of runtimeHooks) {
        lines.push(`  ${hook.id}: ${hook.event} (${hook.type}) [${hook.enabled ? "enabled" : "disabled"}]`);
      }
      lines.push("");
    }
    if (settingsHooks.length > 0) {
      lines.push("Settings hooks:");
      for (const hook of settingsHooks) {
        lines.push(`  ${hook.id}: ${hook.event} (${hook.type}) [${hook.enabled ? "enabled" : "disabled"}]`);
      }
    }
    emit(lines.join("\n"));
    return "handled";
  }

  if (slash?.name === "/subagents") {
    const agents = await client.listAgentPersonas();
    emit(
      [
        `Available subagent personas (${agents.length}):`,
        "",
        ...agents.flatMap((agent) => [
          `- ${agent.name} [${agent.source ?? "builtin"}]${agent.model ? ` model=${agent.model}` : ""}`,
          `    ${agent.description.split("\n")[0]?.slice(0, 100) ?? ""}`,
        ]),
        "",
        '用法: Agent 工具 subagentType="<name>" 派发;/agents 查看运行中任务。',
      ].join("\n"),
    );
    return "handled";
  }

  if (slash?.name === "/diff") {
    const full = slash.args.trim().split(/\s+/).includes("full");
    emit(await client.getGitDiff({ cwd, full }));
    return "handled";
  }

  if (slash?.name === "/branch") {
    const list = slash.args.trim().split(/\s+/).includes("list");
    emit(await client.getGitBranch({ cwd, list }));
    return "handled";
  }

  if (slash?.name === "/commit") {
    const message = slash.args.trim();
    if (!message) {
      emit(await client.getGitStatus({ cwd }));
      return "handled";
    }
    emit(await client.gitCommit({ cwd, message }));
    return "handled";
  }

  if (slash && LOCAL_COMMAND_NAMES.has(slash.name)) {
    // UI-only commands are handled by the host UI layer; ignore accidental falls-through.
    return "local_ui";
  }

  return "unhandled";
}
