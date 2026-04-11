export interface AuthCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface AuthProvider {
  name: string;
  authenticate(): Promise<AuthCredentials>;
  refresh(credentials: AuthCredentials): Promise<AuthCredentials>;
}

export class ApiKeyFlow implements AuthProvider {
  name = "api-key";
  private key: string;

  constructor(key: string) {
    this.key = key;
  }

  async authenticate(): Promise<AuthCredentials> {
    return { provider: this.name, accessToken: this.key };
  }

  async refresh(_credentials: AuthCredentials): Promise<AuthCredentials> {
    return { provider: this.name, accessToken: this.key };
  }
}

export class DeviceCodeFlow implements AuthProvider {
  name = "device-code";
  private clientId: string;
  private deviceCodeUrl: string;
  private tokenUrl: string;

  constructor(clientId: string, deviceCodeUrl: string, tokenUrl: string) {
    this.clientId = clientId;
    this.deviceCodeUrl = deviceCodeUrl;
    this.tokenUrl = tokenUrl;
  }

  async authenticate(): Promise<AuthCredentials> {
    void this.clientId;
    void this.deviceCodeUrl;
    void this.tokenUrl;
    return { provider: this.name, accessToken: "placeholder" };
  }

  async refresh(credentials: AuthCredentials): Promise<AuthCredentials> {
    void this.tokenUrl;
    return { ...credentials, accessToken: "placeholder" };
  }
}

export class AuthManager {
  private providers = new Map<string, AuthProvider>();
  private credentials = new Map<string, AuthCredentials>();

  registerProvider(provider: AuthProvider): void {
    this.providers.set(provider.name, provider);
  }

  async authenticate(providerName: string): Promise<AuthCredentials> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Unknown auth provider: ${providerName}`);
    const creds = await provider.authenticate();
    this.credentials.set(providerName, creds);
    return creds;
  }

  getCredentials(providerName: string): AuthCredentials | undefined {
    return this.credentials.get(providerName);
  }
}
