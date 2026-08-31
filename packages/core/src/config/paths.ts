import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface ResolvedPaths {
  configDir: string;
  dataDir: string;
  logsDir: string;
  sessionsDir: string;
  pluginsDir: string;
  skillsDir: string;
  tasksDir: string;
  feedbackDir: string;
  configFilePath: string;
  credentialsFilePath: string;
}

let _cached: ResolvedPaths | undefined;

export function resolvePaths(projectRoot?: string): ResolvedPaths {
  const configDir =
    process.env.OPENHARNESS_CONFIG_DIR ?? join(homedir(), ".openharness-ts");
  if (_cached && !projectRoot && _cached.configDir === configDir) return _cached;

  const dataDir = join(configDir, "data");
  const projectRootResolved = projectRoot ?? process.cwd();

  const paths: ResolvedPaths = {
    configDir,
    dataDir,
    logsDir: join(dataDir, "logs"),
    sessionsDir: join(dataDir, "sessions"),
    pluginsDir: join(configDir, "plugins"),
    skillsDir: join(configDir, "skills"),
    tasksDir: join(dataDir, "tasks"),
    feedbackDir: join(dataDir, "feedback"),
    configFilePath: join(configDir, "settings.json"),
    credentialsFilePath: join(configDir, "credentials.json"),
  };

  if (!projectRoot) _cached = paths;
  return paths;
}

export function getConfigDir(): string {
  return resolvePaths().configDir;
}

export function getConfigFilePath(): string {
  return resolvePaths().configFilePath;
}

export function getProjectConfigDir(projectRoot?: string): string {
  return join(resolve(projectRoot ?? process.cwd()), ".openharness");
}

export function getProjectSettingsFilePath(projectRoot?: string): string {
  return join(getProjectConfigDir(projectRoot), "settings.json");
}

export function getDataDir(): string {
  return resolvePaths().dataDir;
}

export function getLogsDir(): string {
  return resolvePaths().logsDir;
}

export function getSessionsDir(): string {
  return resolvePaths().sessionsDir;
}

export function getTasksDir(): string {
  return resolvePaths().tasksDir;
}

export function getPluginsDir(): string {
  return resolvePaths().pluginsDir;
}

export function getPluginCacheDir(): string {
  return join(getPluginsDir(), "cache");
}

export function getPluginDataDir(): string {
  return join(getPluginsDir(), "data");
}

export function getPluginSourcesDir(): string {
  return join(getPluginsDir(), "sources");
}

export function getInstalledPluginStorePath(): string {
  return join(getPluginsDir(), "installed.json");
}

export function getSkillsDir(): string {
  return resolvePaths().skillsDir;
}

export function getFeedbackDir(): string {
  return resolvePaths().feedbackDir;
}

export function getCredentialsFilePath(): string {
  return resolvePaths().credentialsFilePath;
}
