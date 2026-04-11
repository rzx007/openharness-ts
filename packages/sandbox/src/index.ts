export interface SandboxConfig {
  runtime?: string;
  image?: string;
  workdir?: string;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class SandboxAdapter {
  private config: SandboxConfig;

  constructor(config: SandboxConfig = {}) {
    this.config = config;
  }

  async execute(command: string, _cwd?: string): Promise<SandboxResult> {
    throw new Error(`Sandbox not yet implemented. Tried to run: ${command}`);
  }

  isAvailable(): boolean {
    return false;
  }
}
