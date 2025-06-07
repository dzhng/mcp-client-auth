/**
 * OAuth2 implementation for MCP (Model Context Protocol) servers
 * Complies with MCP Authorization specification including:
 * - Server metadata discovery (RFC8414)
 * - Dynamic client registration (RFC7591)
 * - OAuth 2.1 with PKCE
 * - Proper token handling and refresh
 */

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import kyFactory, { KyInstance, Options as KyOptions } from 'ky';
import open from 'open';
import * as client from 'openid-client';

// --------------------------- Token Store Interface ----------------------------
export interface TokenStore {
  load(): Promise<StoredToken | undefined>;
  save(token: StoredToken): Promise<void>;
}

interface StoredToken {
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

interface ServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
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
    
    // Use custom discovery with our metadata if available
    if (this.metadata) {
      // Create a custom issuer with our metadata
      const issuer = new URL(this.metadata.issuer || this.authBaseUrl);
      
      // Create configuration directly from our metadata
      this.config = {
        serverMetadata: () => ({
          issuer: this.metadata!.issuer,
          authorization_endpoint: this.metadata!.authorization_endpoint,
          token_endpoint: this.metadata!.token_endpoint,
          registration_endpoint: this.metadata!.registration_endpoint,
        }),
        clientId: this.opts.clientId!,
        clientSecret: this.opts.clientSecret,
        clientMetadata: () => ({
          client_id: this.opts.clientId!,
          client_secret: this.opts.clientSecret,
        }),
      } as client.Configuration;
    } else {
      // Fallback to standard discovery
      this.config = await client.discovery(
        new URL(this.authBaseUrl),
        this.opts.clientId!,
        this.opts.clientSecret
      );
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
      await this.interactiveLogin();
    }
    
    // Check if token is expired
    if (this.isTokenExpired()) {
      if (this.token!.refresh_token) {
        await this.refreshAccessToken();
      } else {
        await this.interactiveLogin();
      }
    }
    
    return this.token!.access_token;
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
   * Interactive browser-based login flow with PKCE
   */
  private async interactiveLogin(): Promise<void> {
    if (!this.config) {
      throw new Error('OAuth not initialized');
    }
    
    const { redirectUri, store } = this.opts;
    
    // Generate PKCE parameters
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    
    const authParams: Record<string, string> = {
      redirect_uri: redirectUri!,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      response_type: 'code',
    };
    
    // Build authorization URL
    const authUrl = client.buildAuthorizationUrl(this.config, authParams);
    
    // Open browser for authorization
    console.log('Opening browser for authentication...');
    await open(authUrl.href);
    
    // Start local server to receive callback
    const code = await this.waitForCallback(redirectUri!, state);
    
    // Exchange authorization code for tokens
    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);
    
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
    await store!.save(this.token);
  }
  
  /**
   * Wait for OAuth callback on local server
   */
  private async waitForCallback(redirectUri: string, expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(redirectUri);
      const server = http.createServer((req, res) => {
        const callbackUrl = new URL(req.url!, redirectUri);
        
        // Validate state parameter
        const state = callbackUrl.searchParams.get('state');
        if (state !== expectedState) {
          res.writeHead(400);
          res.end('Invalid state parameter');
          server.close();
          reject(new Error('OAuth state mismatch'));
          return;
        }
        
        // Check for OAuth error
        const error = callbackUrl.searchParams.get('error');
        if (error) {
          const errorDesc = callbackUrl.searchParams.get('error_description') || error;
          res.writeHead(400);
          res.end(`Authentication failed: ${errorDesc}`);
          server.close();
          reject(new Error(`OAuth error: ${errorDesc}`));
          return;
        }
        
        // Get authorization code
        const code = callbackUrl.searchParams.get('code');
        if (!code) {
          res.writeHead(400);
          res.end('Missing authorization code');
          server.close();
          reject(new Error('Missing authorization code'));
          return;
        }
        
        // Success response
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body>
              <h1>Authentication successful!</h1>
              <p>You can close this window and return to your terminal.</p>
              <script>window.close();</script>
            </body>
          </html>
        `);
        
        server.close();
        resolve(code);
      });
      
      const port = parseInt(url.port, 10);
      server.listen(port, 'localhost', () => {
        console.log(`Listening for OAuth callback on http://localhost:${port}`);
      });
      
      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth callback timeout'));
      }, 5 * 60 * 1000);
    });
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
}