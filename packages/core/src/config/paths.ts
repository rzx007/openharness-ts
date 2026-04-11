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
}

export function resolvePaths(projectRoot?: string): ResolvedPaths {
  const configDir = join(homedir(), ".openharness");
  const dataDir = join(configDir, "data");
  const projectRootResolved = projectRoot ?? process.cwd();

  return {
    configDir,
    dataDir,
    logsDir: join(dataDir, "logs"),
    sessionsDir: join(dataDir, "sessions"),
    pluginsDir: join(configDir, "plugins"),
    skillsDir: join(configDir, "skills"),
    memoryDir: join(projectRootResolved, ".openharness", "memory"),
  };
}
