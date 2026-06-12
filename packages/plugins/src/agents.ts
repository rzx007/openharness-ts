import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  parseAgentFrontmatter,
  buildAgentDefinition,
  type AgentDefinition,
} from "@openharness/coordinator";
import type { PluginManifest } from "./discovery.js";

/**
 * 插件 agents 贡献（移植自 Python plugins/loader.py 的 _load_plugin_agents 段）。
 *
 * 默认 `agents/` 目录递归 + manifest.agents 路径（文件或目录）；
 * agent 名带插件前缀与目录命名空间：`<plugin>:<ns>:<base>`，base 取
 * frontmatter name 或文件名。frontmatter 解析复用 coordinator 的
 * buildAgentDefinition（与用户 agent 同一套字段语义），source="plugin"。
 */

async function loadSingleAgentFile(
  filePath: string,
  pluginName: string,
  namespace: string[],
  seen: Set<string>,
): Promise<AgentDefinition | null> {
  if (!existsSync(filePath)) return null;
  const key = resolve(filePath);
  if (seen.has(key)) return null;
  seen.add(key);

  try {
    if (!statSync(filePath).isFile()) return null;
    const content = await readFile(filePath, "utf-8");
    const { frontmatter, body } = parseAgentFrontmatter(content);
    const stem = basename(filePath, ".md");
    const baseName = (typeof frontmatter.name === "string" && frontmatter.name.trim()) || stem;
    const agentName = [pluginName, ...namespace, baseName].join(":");

    const agent = buildAgentDefinition(frontmatter, body, {
      stem: baseName,
      baseDir: join(filePath, ".."),
      source: "plugin",
      nameOverride: agentName,
      descriptionFallback: `Agent from ${pluginName} plugin`,
    });
    // subagentType 跟随全名（frontmatter 显式 subagent_type 仍优先，由 build 处理）。
    if (agent.subagentType === baseName) agent.subagentType = agentName;
    return agent;
  } catch {
    return null; // 坏文件跳过
  }
}

async function loadAgentsFromDirectory(
  directory: string,
  pluginName: string,
  namespace: string[],
  seen: Set<string>,
): Promise<AgentDefinition[]> {
  if (!existsSync(directory)) return [];
  const agents: AgentDefinition[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      agents.push(...(await loadAgentsFromDirectory(full, pluginName, [...namespace, entry], seen)));
    } else if (entry.toLowerCase().endsWith(".md")) {
      const agent = await loadSingleAgentFile(full, pluginName, namespace, seen);
      if (agent) agents.push(agent);
    }
  }
  return agents;
}

/** 默认 agents/ 目录 + manifest.agents 路径形态，resolve 去重。 */
export async function loadPluginAgents(
  pluginPath: string,
  manifest: PluginManifest,
): Promise<AgentDefinition[]> {
  const seen = new Set<string>();
  const agents: AgentDefinition[] = [];

  agents.push(...(await loadAgentsFromDirectory(join(pluginPath, "agents"), manifest.name, [], seen)));

  const rawPaths =
    typeof manifest.agents === "string" ? [manifest.agents] : (manifest.agents ?? []);
  for (const rawPath of rawPaths) {
    const agentPath = resolve(pluginPath, rawPath);
    if (!existsSync(agentPath)) continue;
    if (statSync(agentPath).isDirectory()) {
      agents.push(...(await loadAgentsFromDirectory(agentPath, manifest.name, [], seen)));
    } else if (agentPath.toLowerCase().endsWith(".md")) {
      const agent = await loadSingleAgentFile(agentPath, manifest.name, [], seen);
      if (agent) agents.push(agent);
    }
  }
  return agents;
}
