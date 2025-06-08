/**
 * OAuth2 library for MCP (Model Context Protocol) servers
 *
 * Provides OAuth2 functionality without handling UI concerns:
 * - Server metadata discovery (RFC8414)
 * - Dynamic client registration (RFC7591)
 * - Authorization URL generation with PKCE
 * - Token exchange and refresh
 * - Bearer token management
 */

import * as fs from 'node:fs/promises';
import kyFactory, { KyInstance, Options as KyOptions } from 'ky';
import * as client from 'openid-client';
import { Configuration } from 'openid-client';

// --------------------------- Token Store Interface ----------------------------

/**
 * Interface for persisting OAuth data between sessions
 */
export interface OAuthStore {
  /** Load stored OAuth data from persistent storage */
  load(): Promise<StoredOAuthData | undefined>;
  /** Save OAuth data to persistent storage */
  save(data: StoredOAuthData): Promise<void>;
  /** Clear stored data */
  clear(): Promise<void>;
}

/**
 * Stored client registration data
 */
export interface StoredClient {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
}

/**
 * Stored token data
 */
export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
}

/**
 * Complete OAuth data structure including client registration and tokens
 */
export interface StoredOAuthData {
  /** Client registration info */
  client?: StoredClient;
  /** Token info */
  token?: StoredToken;
}

/**
 * Simple file-based OAuth data storage implementation
 */
export class JsonOAuthStore implements OAuthStore {
  constructor(private path = '.mcp-oauth.json') {}

  async load(): Promise<StoredOAuthData | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch {
      return undefined;
    }
  }

  async save(data: StoredOAuthData): Promise<void> {
    await fs.writeFile(this.path, JSON.stringify(data, null, 2), 'utf8');
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.path);
    } catch {
      // Ignore if file doesn't exist
    }
  }
}

// --------------------------- OAuth Configuration ------------------------------
export interface McpOAuthOptions {
  /** The MCP server URL */
  serverUrl: string;
  /** Optional pre-registered client ID */
  clientId?: string;
  /** Optional client secret (for confidential clients) */
  clientSecret?: string;
  /** OAuth redirect URI (defaults to http://localhost:3334/callback) */
  redirectUri?: string;
  /** OAuth data storage implementation (defaults to JsonOAuthStore) */
  store?: OAuthStore;
  /** Additional Ky options for HTTP requests */
  kyOpts?: KyOptions;
  /** MCP protocol version (defaults to 2024-11-05) */
  protocolVersion?: string;
}

export interface ServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
}

export interface AuthorizationRequest {
  /** The authorization URL to redirect the user to */
  url: string;
  /** OAuth state parameter for CSRF protection */
  state: string;
  /** PKCE code verifier to use during token exchange */
  codeVerifier: string;
}

// Default endpoint paths per MCP spec
const DEFAULT_ENDPOINTS = {
  authorize: '/authorize',
  token: '/token',
  register: '/register',
};

export class McpOAuth {
  private config?: client.Configuration;
  private kyInstance?: KyInstance;
  private metadata?: ServerMetadata;
  private authBaseUrl: string;
  private oauthData: StoredOAuthData = {};

  constructor(private opts: McpOAuthOptions) {
    // Determine authorization base URL by removing path from server URL
    const url = new URL(opts.serverUrl);
    this.authBaseUrl = `${url.protocol}//${url.host}`;
  }

  /**
   * Check if the MCP server requires authentication
   * @returns true if server returns 401, false otherwise
   */
  async checkAuthRequired(): Promise<boolean> {
    try {
      const response = await kyFactory.get(this.opts.serverUrl, {
        timeout: 5000,
        throwHttpErrors: false,
        headers: {
          'MCP-Protocol-Version': this.opts.protocolVersion || '2024-11-05',
        },
      });

      return response.status === 401;
    } catch (error) {
      // Network error or timeout - assume no auth required
      return false;
    }
  }

  /**
   * Initialize OAuth client - discovers metadata, performs client registration if needed
   * Must be called before using other OAuth methods
   */
  async init(): Promise<void> {
    const {
      redirectUri = 'http://localhost:3334/callback',
      store = new JsonOAuthStore(),
      protocolVersion = '2024-11-05',
    } = this.opts;

    this.opts.store = store;
    this.opts.redirectUri = redirectUri;
    this.opts.protocolVersion = protocolVersion;

    // 1) Load any saved OAuth data
    const savedData = await store.load();
    if (savedData) {
      this.oauthData = savedData;
      // Restore client info if not provided in options
      if (!this.opts.clientId && savedData.client) {
        this.opts.clientId = savedData.client.client_id;
        this.opts.clientSecret = savedData.client.client_secret;
      }
    }

    // 2) Try server metadata discovery
    await this.discoverMetadata();

    // 3) Perform dynamic client registration if needed
    if (!this.opts.clientId && this.metadata!.registration_endpoint) {
      await this.dynamicClientRegistration();
    }

    // 4) Initialize openid-client configuration
    if (!this.opts.clientId) {
      throw new Error(
        'No client ID available. Server does not support dynamic registration.',
      );
    }

    this.config = new Configuration(
      this.metadata as client.ServerMetadata,
      this.opts.clientId,
      this.opts.clientSecret,
    );
  }

  /**
   * Discover OAuth server metadata per RFC8414
   */
  private async discoverMetadata(): Promise<void> {
    const metadataUrl = `${this.authBaseUrl}/.well-known/oauth-authorization-server`;

    try {
      const response = await kyFactory(metadataUrl, {
        headers: {
          'MCP-Protocol-Version': this.opts.protocolVersion!,
        },
        timeout: 5000,
      }).json<ServerMetadata>();

      this.metadata = response;
    } catch (error) {
      // Fall back to default endpoints if discovery fails
      console.warn('OAuth metadata discovery failed, using default endpoints');
      this.metadata = {
        issuer: this.authBaseUrl,
        authorization_endpoint: `${this.authBaseUrl}${DEFAULT_ENDPOINTS.authorize}`,
        token_endpoint: `${this.authBaseUrl}${DEFAULT_ENDPOINTS.token}`,
        registration_endpoint: `${this.authBaseUrl}${DEFAULT_ENDPOINTS.register}`,
      };
    }
  }

  /**
   * Perform dynamic client registration per RFC7591
   */
  private async dynamicClientRegistration(): Promise<void> {
    if (!this.metadata?.registration_endpoint) {
      return;
    }

    const registrationData = {
      client_name: 'MCP Client',
      redirect_uris: [this.opts.redirectUri!],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // Public client
    };

    try {
      const response = await kyFactory
        .post(this.metadata.registration_endpoint, {
          json: registrationData,
          headers: {
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': this.opts.protocolVersion!,
          },
        })
        .json<ClientRegistrationResponse>();

      // Update options with dynamically registered client
      this.opts.clientId = response.client_id;
      this.opts.clientSecret = response.client_secret;

      // Persist client registration for future use
      this.oauthData.client = {
        client_id: response.client_id,
        client_secret: response.client_secret,
        client_secret_expires_at: response.client_secret_expires_at,
      };
      await this.opts.store!.save(this.oauthData);
    } catch (error) {
      console.warn('Dynamic client registration failed:', error);
    }
  }

  /**
   * Generate authorization URL with PKCE
   * @returns Authorization request with URL, state, and code verifier
   */
  async createAuthorizationRequest(): Promise<AuthorizationRequest> {
    if (!this.config) {
      throw new Error('OAuth not initialized');
    }

    // Generate PKCE parameters
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const authParams: Record<string, string> = {
      redirect_uri: this.opts.redirectUri!,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      response_type: 'code',
    };

    // Build authorization URL
    const authUrl = client.buildAuthorizationUrl(this.config, authParams);

    return {
      url: authUrl.href,
      state,
      codeVerifier,
    };
  }

  /**
   * Exchange authorization code for access and refresh tokens
   * @param code - Authorization code from OAuth callback
   * @param state - State parameter from OAuth callback (for CSRF validation)
   * @param codeVerifier - PKCE code verifier from createAuthorizationRequest
   * @returns Stored token with access_token, refresh_token, and expiration
   */
  async exchangeCodeForToken(
    code: string,
    state: string,
    codeVerifier: string,
  ): Promise<StoredToken> {
    if (!this.config) {
      throw new Error('OAuth not initialized');
    }

    // Create callback URL with code and state
    const callbackUrl = new URL(this.opts.redirectUri!);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    // Exchange code for tokens
    try {
      const tokenResponse = await client.authorizationCodeGrant(
        this.config,
        callbackUrl,
        {
          pkceCodeVerifier: codeVerifier,
          expectedState: state,
        },
      );

      // Convert and store token
      const token = this.convertTokenResponse(tokenResponse);
      this.oauthData.token = token;
      await this.opts.store!.save(this.oauthData);

      return token;
    } catch (error: any) {
      // Log more details about the error
      console.error(
        'Token exchange error details:',
        error instanceof client.ResponseBodyError
          ? {
              error,
              cause: error.cause,
              response: error.response,
            }
          : error,
      );
      throw error;
    }
  }

  /**
   * Get Ky HTTP client with automatic Bearer token injection and refresh
   * @returns Ky instance that automatically adds Authorization header
   */
  async ky(): Promise<KyInstance> {
    if (!this.kyInstance) {
      this.kyInstance = kyFactory.create({
        ...this.opts.kyOpts,
        hooks: {
          beforeRequest: [
            async request => {
              const token = await this.getAccessToken();
              request.headers.set('Authorization', `Bearer ${token}`);
            },
          ],
          afterResponse: [
            async (_request, _options, response) => {
              // Handle 401 responses by refreshing token
              if (
                response.status === 401 &&
                this.oauthData.token?.refresh_token
              ) {
                await this.refreshAccessToken();
                // Retry the request with new token
                throw new Error('Token refreshed, retry request');
              }
              return response;
            },
          ],
        },
      });
    }
    return this.kyInstance;
  }

  /**
   * Get valid access token, automatically refreshing if expired
   * @returns Current access token
   * @throws Error if no token available or refresh fails
   */
  async getAccessToken(): Promise<string> {
    if (!this.oauthData.token) {
      throw new Error('No token available. Please authenticate first.');
    }

    // Check if token is expired
    if (this.isTokenExpired()) {
      if (this.oauthData.token.refresh_token) {
        await this.refreshAccessToken();
      } else {
        throw new Error('Token expired and no refresh token available');
      }
    }

    return this.oauthData.token.access_token;
  }

  /**
   * Check if a valid (non-expired) token is available
   * @returns true if token exists and is not expired
   */
  hasValidToken(): boolean {
    return !!this.oauthData.token && !this.isTokenExpired();
  }

  /**
   * Check if current token is expired
   */
  private isTokenExpired(): boolean {
    if (!this.oauthData.token?.expires_at) {
      return false;
    }

    // Add 5-minute buffer before expiration
    const now = Math.floor(Date.now() / 1000);
    return now > this.oauthData.token.expires_at - 300;
  }

  /**
   * Refresh access token using refresh token
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.config || !this.oauthData.token?.refresh_token) {
      throw new Error(
        'Cannot refresh token: missing configuration or refresh token',
      );
    }

    const tokenResponse = await client.refreshTokenGrant(
      this.config,
      this.oauthData.token.refresh_token,
    );

    // Convert and store token with proper expiration
    this.oauthData.token = this.convertTokenResponse(tokenResponse);
    await this.opts.store!.save(this.oauthData);
  }

  /**
   * Convert token response to stored token format
   */
  private convertTokenResponse(
    response: client.TokenEndpointResponse,
  ): StoredToken {
    const token: StoredToken = {
      access_token: response.access_token!,
      refresh_token: response.refresh_token,
      token_type: response.token_type,
    };

    // Calculate expiration timestamp
    if (response.expires_in) {
      token.expires_at = Math.floor(Date.now() / 1000) + response.expires_in;
    }

    return token;
  }

  /**
   * Clear stored tokens from memory and optionally from storage
   * @param clearStorage - Whether to also clear from persistent storage
   */
  async reset(clearStorage = false): Promise<void> {
    this.oauthData = {};
    if (clearStorage) {
      await this.opts.store!.clear();
    }
  }

  async revokeToken(): Promise<void> {
    if (!this.config) {
      throw new Error(
        'Cannot revoke token: missing configuration or refresh token',
      );
    }

    if (this.oauthData.token?.refresh_token) {
      await client.tokenRevocation(
        this.config,
        this.oauthData.token.refresh_token,
      );
    }

    if (this.oauthData.token?.access_token) {
      await client.tokenRevocation(
        this.config,
        this.oauthData.token.access_token,
      );
    }

    this.oauthData.token = undefined;
    await this.opts.store!.save(this.oauthData);
  }

  /**
   * Get current token metadata (for debugging/display)
   * @returns Current token info without sensitive access_token
   */
  getTokenInfo(): { expiresAt?: Date; hasRefreshToken: boolean } | null {
    if (!this.oauthData.token) return null;
    return {
      expiresAt: this.oauthData.token.expires_at
        ? new Date(this.oauthData.token.expires_at * 1000)
        : undefined,
      hasRefreshToken: !!this.oauthData.token.refresh_token,
    };
  }
}
