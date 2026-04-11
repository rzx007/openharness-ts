export interface OAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scope: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export class OAuthFlow {
  private config: OAuthConfig;

  constructor(config: OAuthConfig) {
    this.config = config;
  }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: this.config.scope,
      state,
    });
    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  async exchangeCode(_code: string): Promise<OAuthTokens> {
    return { accessToken: "placeholder" };
  }

  async refreshTokens(_refreshToken: string): Promise<OAuthTokens> {
    return { accessToken: "placeholder" };
  }
}
