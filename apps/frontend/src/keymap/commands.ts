/**
 * Command registry: merges backend slash commands with local UI commands.
 *
 * Backend provides a list of slash-command strings (e.g., ["/help", "/theme"]).
 * Local commands are UI-driven entries (e.g., { id: "app.exit", title: "Exit", ... }).
 * Both paths feed into ctrl+p command palette, `/` autocomplete, and global hotkeys.
 *
 * Merge strategy:
 * - Backend commands are wrapped as { id: cmd, title: cmd, run: () => submitLine(cmd) }
 * - Local commands override any backend command with the same id
 * - Order: backend entries first (with overrides in place), then pure local entries
 * - slashCommands() filters to entries with id starting with "/"
 */

export type Command = {
  /** Slash command: raw string "/help". Local command: "app.xxx" */
  id: string;
  /** Display name in command palette */
  title: string;
  /** Keybinding hint (display only; dispatch happens at App layer) */
  keybinding?: string;
  /** Action to execute on Enter */
  run: () => void;
};

export type CommandRegistry = {
  /** All commands (backend + local) */
  all: () => Command[];
  /** Get a single command by id */
  get: (id: string) => Command | undefined;
  /** Filter to slash-prefixed commands only */
  slashCommands: () => Command[];
};

export type BackendCommandDetail = { name: string; description?: string };

export function buildRegistry(opts: {
  backendCommands: Array<string | BackendCommandDetail>;
  local: Command[];
  submitLine: (line: string) => void;
}): CommandRegistry {
  const { local, submitLine } = opts;
  // 兼容两种来源：纯名称（旧后端 commands）或带描述（command_details）
  const backendCommands = opts.backendCommands.map((c) =>
    typeof c === "string" ? { name: c, description: undefined } : c,
  );

  // Build a map of local commands by id for quick lookup
  const localMap = new Map<string, Command>();
  for (const cmd of local) {
    localMap.set(cmd.id, cmd);
  }

  // Wrap backend commands, allowing local overrides
  const mergedCommands: Command[] = [];
  const seenIds = new Set<string>();

  // Add backend commands first (or their local overrides if present)
  for (const backendCmd of backendCommands) {
    seenIds.add(backendCmd.name);
    const localOverride = localMap.get(backendCmd.name);
    if (localOverride) {
      mergedCommands.push(localOverride);
    } else {
      mergedCommands.push({
        id: backendCmd.name,
        title: backendCmd.description || backendCmd.name,
        run: () => submitLine(backendCmd.name),
      });
    }
  }

  // Add pure local commands (not in backend)
  for (const localCmd of local) {
    if (!seenIds.has(localCmd.id)) {
      mergedCommands.push(localCmd);
    }
  }

  return {
    all: () => mergedCommands,
    get: (id: string) => mergedCommands.find((c) => c.id === id),
    slashCommands: () => mergedCommands.filter((c) => c.id.startsWith("/")),
  };
}
