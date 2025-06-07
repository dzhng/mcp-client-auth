/**
 * MCP Client with integrated OAuth2 support
 * 
 * Automatically handles:
 * - OAuth2 authentication detection
 * - Token management
 * - Transport selection (StreamableHTTP with SSE fallback)
 */

import { Client as MCP } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { McpOAuth, McpOAuthOptions } from './mcp-oauth.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: any;
}

export interface McpClientOptions {
  url: string;
  oauth?: McpOAuth; // Optional pre-configured OAuth instance
  clientId?: string; // Optional pre-registered OAuth client ID
  clientSecret?: string; // Optional OAuth client secret
  oauthRedirectUri?: string; // OAuth redirect URI
  protocolVersion?: string; // MCP protocol version
}

export class McpClient {
  private client?: MCP;
  private oauth?: McpOAuth;
  private url: string;
  private requiresAuth?: boolean;

  constructor(private opts: McpClientOptions) {
    this.url = opts.url;
    this.oauth = opts.oauth;
  }

  // ------------------------- public high-level helpers ------------------------
  async getServer(): Promise<MCP> {
    return this.connect();
  }

  async listTools(): Promise<McpTool[]> {
    const c = await this.getServer();
    const resp = await c.listTools();
    return resp.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    }));
  }

  async callTool(name: string, args: any) {
    const c = await this.getServer();
    return c.callTool({ name, arguments: args });
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = undefined;
    }
  }

  /**
   * Get OAuth instance if authentication is required
   */
  async getOAuth(): Promise<McpOAuth | undefined> {
    if (this.requiresAuth === undefined) {
      await this.checkAuthRequired();
    }
    return this.requiresAuth ? this.oauth : undefined;
  }

  /**
   * Check if authentication is required
   */
  async isAuthRequired(): Promise<boolean> {
    if (this.requiresAuth === undefined) {
      await this.checkAuthRequired();
    }
    return this.requiresAuth || false;
  }

  // -------------------------- internal connection logic ----------------------
  private async connect(): Promise<MCP> {
    if (this.client) return this.client;

    if (!this.url.startsWith('https://')) {
      throw new Error('MCP servers must be HTTPS');
    }
    
    const baseUrl = new URL(this.url);
    const client = new MCP({ name: 'mcp-kit-client', version: '1.0.0' });

    // Check if auth is required and initialize OAuth if needed
    if (this.requiresAuth === undefined) {
      await this.checkAuthRequired();
    }

    // Create transport with appropriate auth headers
    let requestInit: RequestInit | undefined;
    if (this.requiresAuth && this.oauth) {
      // Ensure OAuth has a valid token
      if (!this.oauth.hasValidToken()) {
        throw new Error('Authentication required. Please authenticate first using getOAuth()');
      }
      
      // Get OAuth token and create auth headers
      const token = await this.oauth.getAccessToken();
      requestInit = {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      };
    }

    // Create transport with auth headers if needed
    const transport = await this.createTransport(baseUrl, requestInit);
    await client.connect(transport);
    this.client = client;
    return client;
  }

  /**
   * Check if the server requires authentication
   */
  private async checkAuthRequired(): Promise<void> {
    // Initialize OAuth instance if not provided
    if (!this.oauth) {
      this.oauth = new McpOAuth({
        serverUrl: this.url,
        clientId: this.opts.clientId,
        clientSecret: this.opts.clientSecret,
        redirectUri: this.opts.oauthRedirectUri,
        protocolVersion: this.opts.protocolVersion,
      });
    }

    // Check if server requires auth
    this.requiresAuth = await this.oauth.checkAuthRequired();
    
    // Initialize OAuth if auth is required
    if (this.requiresAuth) {
      await this.oauth.init();
    }
  }

  /**
   * Create transport with optional request init for auth headers
   */
  private async createTransport(
    baseUrl: URL,
    requestInit?: RequestInit
  ): Promise<StreamableHTTPClientTransport | SSEClientTransport> {
    try {
      // Try StreamableHTTP transport first
      const transport = new StreamableHTTPClientTransport(baseUrl, { requestInit });
      return transport;
    } catch (err) {
      // Fallback to SSE transport
      console.warn('StreamableHTTP transport failed, falling back to SSE');
      return new SSEClientTransport(baseUrl, { requestInit });
    }
  }
}