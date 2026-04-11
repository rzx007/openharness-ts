import type {
  StreamingMessageClient,
  StreamMessageParams,
  StreamEvent,
} from "@openharness/core";
import { OpenAICompatibleClient } from "./openai.js";
import type { ProviderConfig } from "./registry";
import { AuthenticationFailure } from "../errors/index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";

const COPILOT_DEFAULT_MODEL = "gpt-4o";

function copilotApiBase(enterpriseUrl?: string): string {
  if (enterpriseUrl) {
    return `${enterpriseUrl.replace(/\/+$/, "")}/copilot/api/v1`;
  }
  return "https://api.githubcopilot.com/v1";
}

interface CopilotAuthInfo {
  githubToken: string;
  enterpriseUrl?: string;
}

async function loadCopilotAuth(): Promise<CopilotAuthInfo | null> {
  const authPath = join(homedir(), ".openharness", "copilot_auth.json");
  try {
    const raw = await readFile(authPath, "utf-8");
    const data = JSON.parse(raw);
    if (data.github_token) {
      return {
        githubToken: data.github_token,
        enterpriseUrl: data.enterprise_url,
      };
    }
  } catch {}
  return null;
}

export class CopilotClient implements StreamingMessageClient {
  private inner: OpenAICompatibleClient;
  private model?: string;

  constructor(
    config?: ProviderConfig,
    options?: {
      githubToken?: string;
      enterpriseUrl?: string;
      model?: string;
    }
  ) {
    const token = options?.githubToken ?? config?.apiKey;
    if (!token) {
      throw new AuthenticationFailure(
        "No GitHub Copilot token found. Run 'oh auth copilot-login' first."
      );
    }

    const baseUrl = copilotApiBase(options?.enterpriseUrl);
    this.model = options?.model;

    const effectiveConfig: ProviderConfig = {
      apiKey: token,
      baseURL: baseUrl,
    };
    this.inner = new OpenAICompatibleClient(effectiveConfig);

    const rawOpenAI = new OpenAI({
      apiKey: token,
      baseURL: baseUrl,
      defaultHeaders: {
        "User-Agent": "openharness/0.1.0",
        "Openai-Intent": "conversation-edits",
      },
    });
    this.inner.client = rawOpenAI;
  }

  async *streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> {
    const effectiveModel = this.model ?? params.model ?? COPILOT_DEFAULT_MODEL;
    yield* this.inner.streamMessage({ ...params, model: effectiveModel });
  }
}

export { copilotApiBase, loadCopilotAuth, COPILOT_DEFAULT_MODEL };
