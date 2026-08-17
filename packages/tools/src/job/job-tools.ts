import type { ToolContext, ToolDefinition, ToolResult } from "@openharness/core";
import type { JobStatus } from "@openharness/jobs";

const jobIdProperty = { type: "string", description: "Job id returned by a long-running tool or JobList" };

export const jobListTool: ToolDefinition = {
  name: "JobList",
  description: "List terminal, background task, child-agent, and workflow jobs owned by this session.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["running", "stopping", "completed", "killed", "failed"] },
    },
  },
  async execute(input, context) {
    const host = resolveHost(context);
    if ("content" in host) return host;
    try {
      const jobs = await host.jobs.list({
        sessionId: host.sessionId,
        ...(input.status ? { status: input.status as JobStatus } : {}),
      });
      return result("list", { jobs });
    } catch (error) {
      return failed(error);
    }
  },
};

export const jobReadTool: ToolDefinition = {
  name: "JobRead",
  description: "Read output produced after an optional cursor and return the current job snapshot.",
  inputSchema: {
    type: "object",
    properties: {
      jobId: jobIdProperty,
      after: { type: "number", description: "Cursor returned by an earlier JobRead or JobWait" },
      maxChars: { type: "number", default: 12000 },
    },
    required: ["jobId"],
  },
  async execute(input, context) {
    const host = resolveHost(context);
    if ("content" in host) return host;
    try {
      const read = await host.jobs.read({
        sessionId: host.sessionId,
        jobId: requiredString(input.jobId, "jobId"),
        after: optionalNumber(input.after),
        maxChars: optionalNumber(input.maxChars),
      });
      return result("read", read);
    } catch (error) {
      return failed(error);
    }
  },
};

export const jobWaitTool: ToolDefinition = {
  name: "JobWait",
  description: "Wait for a job to finish without cancelling it, bounded by timeoutSeconds.",
  inputSchema: {
    type: "object",
    properties: {
      jobId: jobIdProperty,
      after: { type: "number", description: "Cursor returned by an earlier JobRead or JobWait" },
      timeoutSeconds: { type: "number", default: 30 },
      maxChars: { type: "number", default: 12000 },
    },
    required: ["jobId"],
  },
  async execute(input, context) {
    const host = resolveHost(context);
    if ("content" in host) return host;
    try {
      const timeoutSeconds = optionalNumber(input.timeoutSeconds) ?? 30;
      if (timeoutSeconds <= 0) throw new Error("timeoutSeconds must be positive.");
      const waited = await host.jobs.wait({
        sessionId: host.sessionId,
        jobId: requiredString(input.jobId, "jobId"),
        timeoutMs: timeoutSeconds * 1_000,
        after: optionalNumber(input.after),
        maxChars: optionalNumber(input.maxChars),
        signal: context.abortSignal,
      });
      return result("wait", waited);
    } catch (error) {
      return failed(error);
    }
  },
};

export const jobSendTool: ToolDefinition = {
  name: "JobSend",
  description: "Send input to an interactive terminal or agent job that accepts input.",
  inputSchema: {
    type: "object",
    properties: { jobId: jobIdProperty, data: { type: "string" } },
    required: ["jobId", "data"],
  },
  async execute(input, context) {
    const host = resolveHost(context);
    if ("content" in host) return host;
    try {
      const jobId = requiredString(input.jobId, "jobId");
      await host.jobs.send({ sessionId: host.sessionId, jobId, data: String(input.data ?? "") });
      return result("send", { jobId });
    } catch (error) {
      return failed(error);
    }
  },
};

export const jobCancelTool: ToolDefinition = {
  name: "JobCancel",
  description: "Request cancellation of a job owned by this session.",
  inputSchema: {
    type: "object",
    properties: { jobId: jobIdProperty, reason: { type: "string" } },
    required: ["jobId"],
  },
  async execute(input, context) {
    const host = resolveHost(context);
    if ("content" in host) return host;
    try {
      const snapshot = await host.jobs.cancel({
        sessionId: host.sessionId,
        jobId: requiredString(input.jobId, "jobId"),
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
      });
      return result("cancel", { snapshot });
    } catch (error) {
      return failed(error);
    }
  },
};

export const jobTools = [jobListTool, jobReadTool, jobWaitTool, jobSendTool, jobCancelTool];

function resolveHost(context: ToolContext): { jobs: NonNullable<ToolContext["jobs"]>; sessionId: string } | ToolResult {
  if (!context.jobs) return failed("This host does not provide background jobs.");
  if (!context.sessionId) return failed("Background jobs require a durable session.");
  return { jobs: context.jobs, sessionId: context.sessionId };
}

function result(action: string, value: object): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ kind: "job", action, ...value }) }] };
}

function failed(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
