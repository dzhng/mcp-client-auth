/**
 * MCP Client with integrated OAuth2 support
 * 
 * Automatically handles:
 * - OAuth2 server metadata discovery
 * - Dynamic client registration
 * - Token management and refresh
 * - Transport selection (StreamableHTTP with SSE fallback)
 */

import { Client as MCP } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import ky, { HTTPError } from 'ky';

import { McpOAuth, McpOAuthOptions } from './mcp-oauth.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: any;
}

export interface McpClientOptions {
  url: string;
  clientId?: string; // Optional pre-registered OAuth client ID
  clientSecret?: string; // Optional OAuth client secret
  oauthRedirectUri?: string; // OAuth redirect URI (default: http://localhost:3334/callback)
  protocolVersion?: string; // MCP protocol version (default: 2024-11-05)
}

export class McpClient {
  private client?: MCP;
  private oauth?: McpOAuth;
  private url: string;
  private oauthOptions: Partial<McpOAuthOptions>;
  private requiresAuth?: boolean;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.oauthOptions = {
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      redirectUri: opts.oauthRedirectUri,
      protocolVersion: opts.protocolVersion,
    };
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

  // -------------------------- internal connection logic ----------------------
  private async connect(): Promise<MCP> {
    if (this.client) return this.client;

    if (!this.url.startsWith('https://')) {
      throw new Error('MCP servers must be HTTPS');
    }
    
    const baseUrl = new URL(this.url);
    const client = new MCP({ name: 'mcp-kit-client', version: '1.0.0' });

    // Try initial connection to check if auth is required
    if (this.requiresAuth === undefined) {
      await this.checkAuthRequired();
    }

    // Create transport with appropriate auth headers
    let requestInit: RequestInit | undefined;
    if (this.requiresAuth && this.oauth) {
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
    try {
      // Try to access the server without auth
      const response = await ky.get(this.url, {
        timeout: 5000,
        throwHttpErrors: false,
      });
      
      if (response.status === 401) {
        // Server requires authentication
        this.requiresAuth = true;
        await this.initializeOAuth();
      } else {
        // Server doesn't require auth or returned another status
        this.requiresAuth = false;
      }
    } catch (error) {
      // Network error or timeout - assume no auth required
      this.requiresAuth = false;
    }
  }

  /**
   * Initialize OAuth client
   */
  private async initializeOAuth(): Promise<void> {
    if (!this.oauth) {
      this.oauth = new McpOAuth({
        serverUrl: this.url,
        ...this.oauthOptions,
      });
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
