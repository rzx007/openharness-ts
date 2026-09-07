import { spawn } from "node:child_process";

import {
  DOCKER_CREATED_BY_GENERATION_LABEL,
  DOCKER_CREATED_BY_OWNER_LABEL,
  DOCKER_INSTALLATION_LABEL,
  DOCKER_MANAGED_LABEL,
  DOCKER_REUSABLE_LABEL,
  DOCKER_WORKSPACE_OWNER_LABEL,
} from "./docker-backend.js";

export interface DockerManagedExecution {
  pid: number;
  daemonOwnerId: string;
  daemonGeneration: number;
  environmentId: string;
  executionKind: string;
  executionId: string;
}

export interface DockerManagedContainer {
  id: string;
  name: string;
  running: boolean;
  installationId: string;
  workspaceOwnerId: string;
  reusable: boolean;
  createdByOwnerId: string;
  createdByGeneration: number;
  executions: DockerManagedExecution[];
}

export interface DockerReconciliationDiagnostic {
  code:
    | "docker_inventory_failed"
    | "container_inspect_failed"
    | "execution_inventory_failed"
    | "execution_inventory_invalid"
    | "ownership_unverified"
    | "cleanup_action_failed";
  message: string;
  containerId?: string;
}

export interface DockerManagedResourceInventory {
  containers: DockerManagedContainer[];
  diagnostics: DockerReconciliationDiagnostic[];
}

export type DockerCleanupAction =
  | {
      kind: "kill_execution";
      containerId: string;
      pid: number;
      reason: "stale_daemon_execution";
    }
  | {
      kind: "remove_container";
      containerId: string;
      reason: "orphan_temporary_environment";
    };

export interface DockerReconciliationPlan {
  actions: DockerCleanupAction[];
  diagnostics: DockerReconciliationDiagnostic[];
}

export interface DockerCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type DockerCommandRunner = (
  command: string,
  args: string[],
) => Promise<DockerCommandResult>;

export interface ReconcileDockerOrphansInput {
  installationId: string;
  daemon: { ownerId: string; generation: number };
  dockerCommand?: string;
  runDocker?: DockerCommandRunner;
}

export interface DockerReconciliationReport extends DockerReconciliationPlan {}

export function planDockerOrphanReconciliation(
  inventory: DockerManagedResourceInventory,
  current: Pick<ReconcileDockerOrphansInput, "installationId" | "daemon">,
): DockerReconciliationPlan {
  const actions: DockerCleanupAction[] = [];
  const diagnostics = [...inventory.diagnostics];
  const seenExecutions = new Set<string>();

  for (const container of inventory.containers) {
    if (
      !container.installationId ||
      container.installationId !== current.installationId ||
      !container.workspaceOwnerId
    ) {
      diagnostics.push({
        code: "ownership_unverified",
        message: `Docker resource ${container.name || container.id} does not belong to this OpenHarness installation`,
        containerId: container.id,
      });
      continue;
    }

    if (!container.reusable) {
      if (!container.createdByOwnerId || container.createdByGeneration < 1) {
        diagnostics.push({
          code: "ownership_unverified",
          message: `Temporary Docker resource ${container.name || container.id} has no verifiable daemon owner`,
          containerId: container.id,
        });
        continue;
      }
      if (!sameDaemon(container, current.daemon)) {
        actions.push({
          kind: "remove_container",
          containerId: container.id,
          reason: "orphan_temporary_environment",
        });
      }
      continue;
    }

    for (const execution of container.executions) {
      if (!execution.daemonOwnerId || execution.daemonGeneration < 1) {
        diagnostics.push({
          code: "ownership_unverified",
          message: `Docker execution ${execution.pid} has no verifiable daemon owner`,
          containerId: container.id,
        });
        continue;
      }
      if (
        execution.daemonOwnerId === current.daemon.ownerId &&
        execution.daemonGeneration === current.daemon.generation
      ) {
        continue;
      }
      const key = `${container.id}:${execution.pid}`;
      if (seenExecutions.has(key)) continue;
      seenExecutions.add(key);
      actions.push({
        kind: "kill_execution",
        containerId: container.id,
        pid: execution.pid,
        reason: "stale_daemon_execution",
      });
    }
  }

  actions.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "kill_execution" ? -1 : 1;
    return left.containerId.localeCompare(right.containerId) ||
      (left.kind === "kill_execution" && right.kind === "kill_execution"
        ? left.pid - right.pid
        : 0);
  });
  return { actions, diagnostics };
}

export async function reconcileDockerOrphans(
  input: ReconcileDockerOrphansInput,
): Promise<DockerReconciliationReport> {
  const dockerCommand = input.dockerCommand ?? "docker";
  const runDocker = input.runDocker ?? runCommand;
  const inventory = await listManagedDockerResources({
    dockerCommand,
    installationId: input.installationId,
    runDocker,
  });
  const plan = planDockerOrphanReconciliation(inventory, input);
  const diagnostics = [...plan.diagnostics];

  for (const action of plan.actions) {
    const result = action.kind === "kill_execution"
      ? await runDocker(dockerCommand, buildKillExecutionArgs(action, input))
      : await runDocker(dockerCommand, ["rm", "-f", action.containerId]);
    if (result.code === 0) continue;
    diagnostics.push({
      code: "cleanup_action_failed",
      message: result.stderr.trim() || `Docker cleanup exited with code ${result.code}`,
      containerId: action.containerId,
    });
  }
  return { actions: plan.actions, diagnostics };
}

export async function listManagedDockerResources(input: {
  dockerCommand: string;
  installationId: string;
  runDocker: DockerCommandRunner;
}): Promise<DockerManagedResourceInventory> {
  const listed = await input.runDocker(input.dockerCommand, [
    "ps",
    "-a",
    "--filter",
    `label=${DOCKER_MANAGED_LABEL}=true`,
    "--format",
    "{{.ID}}\t{{.Names}}",
  ]);
  if (listed.code !== 0) {
    return {
      containers: [],
      diagnostics: [{
        code: "docker_inventory_failed",
        message: listed.stderr.trim() || `docker ps exited with code ${listed.code}`,
      }],
    };
  }

  const containers: DockerManagedContainer[] = [];
  const diagnostics: DockerReconciliationDiagnostic[] = [];
  for (const line of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    const [id, listedName = ""] = line.split("\t");
    if (!id) continue;
    const inspected = await input.runDocker(input.dockerCommand, [
      "container",
      "inspect",
      id,
    ]);
    if (inspected.code !== 0) {
      diagnostics.push({
        code: "container_inspect_failed",
        message: inspected.stderr.trim() || `docker inspect exited with code ${inspected.code}`,
        containerId: id,
      });
      continue;
    }
    const parsed = parseContainerInspect(inspected.stdout, id, listedName);
    if (!parsed) {
      diagnostics.push({
        code: "container_inspect_failed",
        message: `Docker inspect returned invalid JSON for ${id}`,
        containerId: id,
      });
      continue;
    }
    if (
      parsed.running &&
      parsed.reusable &&
      parsed.installationId === input.installationId
    ) {
      const executions = await input.runDocker(input.dockerCommand, [
        "exec",
        parsed.id,
        "/bin/sh",
        "-c",
        EXECUTION_INVENTORY_SCRIPT,
        "openharness-execution-inventory",
        input.installationId,
      ]);
      if (executions.code !== 0) {
        diagnostics.push({
          code: "execution_inventory_failed",
          message: executions.stderr.trim() || `Docker execution inventory exited with code ${executions.code}`,
          containerId: parsed.id,
        });
      } else {
        parsed.executions = parseExecutions(executions.stdout, parsed.id, diagnostics);
      }
    }
    containers.push(parsed);
  }
  return { containers, diagnostics };
}

function sameDaemon(
  container: Pick<DockerManagedContainer, "createdByOwnerId" | "createdByGeneration">,
  daemon: { ownerId: string; generation: number },
): boolean {
  return container.createdByOwnerId === daemon.ownerId &&
    container.createdByGeneration === daemon.generation;
}

function parseContainerInspect(
  value: string,
  fallbackId: string,
  fallbackName: string,
): DockerManagedContainer | undefined {
  try {
    const rows = JSON.parse(value) as unknown;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row !== "object") return undefined;
    const record = row as Record<string, unknown>;
    const config = asRecord(record.Config);
    const labels = asStringRecord(config.Labels);
    const state = asRecord(record.State);
    const name = typeof record.Name === "string"
      ? record.Name.replace(/^\//, "")
      : fallbackName;
    return {
      id: typeof record.Id === "string" ? record.Id : fallbackId,
      name,
      running: state.Running === true,
      installationId: labels[DOCKER_INSTALLATION_LABEL] ?? "",
      workspaceOwnerId: labels[DOCKER_WORKSPACE_OWNER_LABEL] ?? "",
      reusable: labels[DOCKER_REUSABLE_LABEL] === "true",
      createdByOwnerId: labels[DOCKER_CREATED_BY_OWNER_LABEL] ?? "",
      createdByGeneration: positiveInteger(labels[DOCKER_CREATED_BY_GENERATION_LABEL]),
      executions: [],
    };
  } catch {
    return undefined;
  }
}

function parseExecutions(
  output: string,
  containerId: string,
  diagnostics: DockerReconciliationDiagnostic[],
): DockerManagedExecution[] {
  const result: DockerManagedExecution[] = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [pidValue, daemonOwnerId, generationValue, environmentId, executionKind, executionId] =
      line.split("\t");
    const pid = positiveInteger(pidValue);
    const daemonGeneration = positiveInteger(generationValue);
    if (!pid || !daemonOwnerId || !daemonGeneration || !environmentId || !executionKind || !executionId) {
      diagnostics.push({
        code: "execution_inventory_invalid",
        message: `Docker execution inventory returned an invalid row: ${line}`,
        containerId,
      });
      continue;
    }
    result.push({
      pid,
      daemonOwnerId,
      daemonGeneration,
      environmentId,
      executionKind,
      executionId,
    });
  }
  return result;
}

function buildKillExecutionArgs(
  action: Extract<DockerCleanupAction, { kind: "kill_execution" }>,
  input: ReconcileDockerOrphansInput,
): string[] {
  return [
    "exec",
    action.containerId,
    "/bin/sh",
    "-c",
    VERIFY_AND_KILL_EXECUTION_SCRIPT,
    "openharness-kill-stale-execution",
    String(action.pid),
    input.installationId,
    input.daemon.ownerId,
    String(input.daemon.generation),
  ];
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).flatMap(([key, item]) =>
      typeof item === "string" ? [[key, item]] : []
    ),
  );
}

async function runCommand(
  command: string,
  args: string[],
): Promise<DockerCommandResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolvePromise({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

const EXECUTION_INVENTORY_SCRIPT = String.raw`
read_env() {
  tr '\0' '\n' < "$1" 2>/dev/null | grep -m1 "^$2=" | cut -d= -f2-
}
for environment_file in /proc/[0-9]*/environ; do
  [ -r "$environment_file" ] || continue
  installation=$(read_env "$environment_file" OPENHARNESS_INSTALLATION_ID)
  [ "$installation" = "$1" ] || continue
  daemon_owner=$(read_env "$environment_file" OPENHARNESS_DAEMON_OWNER_ID)
  daemon_generation=$(read_env "$environment_file" OPENHARNESS_DAEMON_GENERATION)
  environment_id=$(read_env "$environment_file" OPENHARNESS_ENVIRONMENT_ID)
  execution_kind=$(read_env "$environment_file" OPENHARNESS_EXECUTION_KIND)
  execution_id=$(read_env "$environment_file" OPENHARNESS_EXECUTION_ID)
  pid=\${environment_file#/proc/}
  pid=\${pid%/environ}
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$daemon_owner" "$daemon_generation" "$environment_id" "$execution_kind" "$execution_id"
done
`.trim();

const VERIFY_AND_KILL_EXECUTION_SCRIPT = String.raw`
pid="$1"
expected_installation="$2"
current_owner="$3"
current_generation="$4"
environment_file="/proc/$pid/environ"
[ -r "$environment_file" ] || exit 0
read_env() {
  tr '\0' '\n' < "$1" 2>/dev/null | grep -m1 "^$2=" | cut -d= -f2-
}
installation=$(read_env "$environment_file" OPENHARNESS_INSTALLATION_ID)
owner=$(read_env "$environment_file" OPENHARNESS_DAEMON_OWNER_ID)
generation=$(read_env "$environment_file" OPENHARNESS_DAEMON_GENERATION)
[ "$installation" = "$expected_installation" ] || exit 23
if [ "$owner" = "$current_owner" ] && [ "$generation" = "$current_generation" ]; then exit 24; fi
kill -TERM "$pid" 2>/dev/null || true
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
  sleep 0.05
  i=$((i + 1))
done
kill -KILL "$pid" 2>/dev/null || true
`.trim();
