export interface VoiceConfig {
  language?: string;
  model?: string;
}

export interface VoiceTranscript {
  text: string;
  confidence: number;
  isFinal: boolean;
}

export class VoiceMode {
  private active = false;

  constructor(private config: VoiceConfig = {}) {}

  isActive(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    this.active = true;
    throw new Error("Voice mode not yet implemented");
  }

  async stop(): Promise<void> {
    this.active = false;
  }

  async *listen(): AsyncIterable<VoiceTranscript> {
    throw new Error("Speech-to-text not yet implemented");
  }
}
