export interface LspServerConfig {
  command: string;
  args: string[];
  cwd?: string;
}

export class LspClient {
  private config: LspServerConfig;
  private connected = false;

  constructor(config: LspServerConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
