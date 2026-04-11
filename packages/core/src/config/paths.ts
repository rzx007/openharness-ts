import { join } from "node:path";
import { homedir } from "node:os";

export interface ResolvedPaths {
  configDir: string;
  dataDir: string;
  logsDir: string;
  sessionsDir: string;
  pluginsDir: string;
  skillsDir: string;
  memoryDir: string;
  tasksDir: string;
  feedbackDir: string;
  cronDir: string;
  cronRegistryPath: string;
  cronHistoryPath: string;
  cronLogsDir: string;
  configFilePath: string;
}

let _cached: ResolvedPaths | undefined;

export function resolvePaths(projectRoot?: string): ResolvedPaths {
  if (_cached && !projectRoot) return _cached;

  const configDir =
    process.env.OPENHARNESS_CONFIG_DIR ?? join(homedir(), ".openharness");
  const dataDir = join(configDir, "data");
  const projectRootResolved = projectRoot ?? process.cwd();

  const paths: ResolvedPaths = {
    configDir,
    dataDir,
    logsDir: join(dataDir, "logs"),
    sessionsDir: join(dataDir, "sessions"),
    pluginsDir: join(configDir, "plugins"),
    skillsDir: join(configDir, "skills"),
    memoryDir: join(projectRootResolved, ".openharness", "memory"),
    tasksDir: join(dataDir, "tasks"),
    feedbackDir: join(dataDir, "feedback"),
    cronDir: join(dataDir, "cron"),
    cronRegistryPath: join(dataDir, "cron", "cron_jobs.json"),
    cronHistoryPath: join(dataDir, "cron", "cron_history.jsonl"),
    cronLogsDir: join(dataDir, "cron", "logs"),
    configFilePath: join(configDir, "settings.json"),
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

export function getSkillsDir(): string {
  return resolvePaths().skillsDir;
}

export function getMemoryDir(projectRoot?: string): string {
  return resolvePaths(projectRoot).memoryDir;
}

export function getFeedbackDir(): string {
  return resolvePaths().feedbackDir;
}

export function getCronRegistryPath(): string {
  return resolvePaths().cronRegistryPath;
}

export function getCronHistoryPath(): string {
  return resolvePaths().cronHistoryPath;
}

export function getCronLogsDir(): string {
  return resolvePaths().cronLogsDir;
}
