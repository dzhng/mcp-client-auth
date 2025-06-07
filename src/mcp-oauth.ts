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

// --------------------------- Token Store Interface ----------------------------
export interface TokenStore {
  load(): Promise<StoredToken | undefined>;
  save(token: StoredToken): Promise<void>;
}

export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // Unix timestamp in seconds
  token_type?: string;
}

export class JsonTokenStore implements TokenStore {
  constructor(private path = '.mcp-token.json') {}
  
  async load(): Promise<StoredToken | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch {
      return undefined;
    }
  }
  
  async save(token: StoredToken): Promise<void> {
    await fs.writeFile(this.path, JSON.stringify(token, null, 2), 'utf8');
  }
}

// --------------------------- OAuth Configuration ------------------------------
export interface McpOAuthOptions {
  serverUrl: string; // The MCP server URL
  clientId?: string; // Optional pre-registered client ID
  clientSecret?: string; // Optional client secret
  redirectUri?: string; // OAuth redirect URI
  store?: TokenStore; // Token storage implementation
  kyOpts?: KyOptions; // Additional Ky options
  protocolVersion?: string; // MCP protocol version
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
  url: string;
  state: string;
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
  private token?: StoredToken;
  private kyInstance?: KyInstance;
  private metadata?: ServerMetadata;
  private authBaseUrl: string;
  
  constructor(private opts: McpOAuthOptions) {
    // Determine authorization base URL by removing path from server URL
    const url = new URL(opts.serverUrl);
    this.authBaseUrl = `${url.protocol}//${url.host}`;
  }
  
  /**
   * Check if the MCP server requires authentication
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
   * Initialize OAuth client
   */
  async init(): Promise<void> {
    const {
      redirectUri = 'http://localhost:3334/callback',
      store = new JsonTokenStore(),
      protocolVersion = '2024-11-05',
    } = this.opts;
    
    this.opts.store = store;
    this.opts.redirectUri = redirectUri;
    this.opts.protocolVersion = protocolVersion;
    
    // 1) Try server metadata discovery
    await this.discoverMetadata();
    
    // 2) Perform dynamic client registration if needed
    if (!this.opts.clientId && this.metadata?.registration_endpoint) {
      await this.dynamicClientRegistration();
    }
    
    // 3) Initialize openid-client configuration
    if (!this.opts.clientId) {
      throw new Error(
        'No client ID available. Server does not support dynamic registration.'
      );
    }
    
    // Initialize with discovered or default metadata
    const issuerUrl = this.metadata?.issuer || this.authBaseUrl;
    this.config = await client.discovery(
      new URL(issuerUrl),
      this.opts.clientId,
      this.opts.clientSecret
    );
    
    // Override endpoints if we have custom metadata
    if (this.metadata) {
      // @ts-ignore - accessing private properties for customization
      this.config.serverMetadata = () => ({
        issuer: this.metadata!.issuer,
        authorization_endpoint: this.metadata!.authorization_endpoint,
        token_endpoint: this.metadata!.token_endpoint,
        registration_endpoint: this.metadata!.registration_endpoint,
      });
    }
    
    // 4) Load cached token if any
    const storedToken = await store.load();
    if (storedToken) {
      this.token = storedToken;
    }
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
      
      // TODO: Persist client registration for future use
    } catch (error) {
      console.warn('Dynamic client registration failed:', error);
    }
  }
  
  /**
   * Generate authorization URL with PKCE
   * Returns the URL and state/verifier for later use
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
   * Exchange authorization code for tokens
   */
  async exchangeCodeForToken(
    code: string,
    state: string,
    codeVerifier: string
  ): Promise<StoredToken> {
    if (!this.config) {
      throw new Error('OAuth not initialized');
    }
    
    // Create callback URL with code and state
    const callbackUrl = new URL(this.opts.redirectUri!);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);
    
    // Exchange code for tokens
    const tokenResponse = await client.authorizationCodeGrant(
      this.config,
      callbackUrl,
      {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
      }
    );
    
    // Convert and store token
    this.token = this.convertTokenResponse(tokenResponse);
    await this.opts.store!.save(this.token);
    
    return this.token;
  }
  
  /**
   * Get Ky instance with automatic token injection
   */
  async ky(): Promise<KyInstance> {
    if (!this.kyInstance) {
      this.kyInstance = kyFactory.create({
        ...this.opts.kyOpts,
        hooks: {
          beforeRequest: [
            async (request) => {
              const token = await this.getAccessToken();
              request.headers.set('Authorization', `Bearer ${token}`);
            },
          ],
          afterResponse: [
            async (_request, _options, response) => {
              // Handle 401 responses by refreshing token
              if (response.status === 401 && this.token?.refresh_token) {
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
   * Get valid access token, refreshing if needed
   */
  async getAccessToken(): Promise<string> {
    if (!this.token) {
      throw new Error('No token available. Please authenticate first.');
    }
    
    // Check if token is expired
    if (this.isTokenExpired()) {
      if (this.token.refresh_token) {
        await this.refreshAccessToken();
      } else {
        throw new Error('Token expired and no refresh token available');
      }
    }
    
    return this.token.access_token;
  }
  
  /**
   * Check if we have a valid token
   */
  hasValidToken(): boolean {
    return !!this.token && !this.isTokenExpired();
  }
  
  /**
   * Check if current token is expired
   */
  private isTokenExpired(): boolean {
    if (!this.token?.expires_at) {
      return false;
    }
    
    // Add 5-minute buffer before expiration
    const now = Math.floor(Date.now() / 1000);
    return now > (this.token.expires_at - 300);
  }
  
  /**
   * Refresh access token using refresh token
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.config || !this.token?.refresh_token) {
      throw new Error('Cannot refresh token: missing configuration or refresh token');
    }
    
    const tokenResponse = await client.refreshTokenGrant(
      this.config,
      this.token.refresh_token
    );
    
    // Convert and store token with proper expiration
    this.token = this.convertTokenResponse(tokenResponse);
    await this.opts.store!.save(this.token);
  }
  
  /**
   * Convert token response to stored token format
   */
  private convertTokenResponse(response: client.TokenEndpointResponse): StoredToken {
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
   * Clear stored tokens
   */
  async clearTokens(): Promise<void> {
    this.token = undefined;
    // Optionally clear from storage
    // await this.opts.store?.clear();
  }
}