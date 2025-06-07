/**
 * Thin wrapper around `@modelcontextprotocol/sdk` that automatically handles
 * discovery, OAuth, and connection transport headers using **ky**.
 */

import { Client as MCP } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import ky from 'ky';

import { McpOAuth } from './mcp-oauth.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: any;
}

export interface McpClientOptions {
  url: string;
  oauth?: McpOAuth; // optional – will be auto-initialised on demand
}

export class McpClient {
  private client?: MCP;
  private oauth?: McpOAuth;
  private url: string;

  constructor(opts: McpClientOptions) {
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

  // -------------------------- internal connection logic ----------------------
  private async connect(): Promise<MCP> {
    if (this.client) return this.client;

    if (!this.url.startsWith('https://'))
      throw new Error('MCP servers must be HTTPS');
    const baseUrl = new URL(this.url);

    // 1) see if server advertises its own OAuth discovery doc
    const authInfo = await this.checkAuth(baseUrl.origin);
    let token: string | undefined;

    if (authInfo.requiresAuth) {
      // ensure we have an OAuth helper
      if (!this.oauth) {
        this.oauth = new McpOAuth();
        await this.oauth.init();
      }
      token = await this.oauth.getAccessToken();
    }

    // 2) instantiate SDK client + primary transport
    const client = new MCP({ name: 'aomni-mcp-client', version: '1.0.0' });

    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const requestInit = headers ? { headers } : undefined;
    const primary = new StreamableHTTPClientTransport(baseUrl, { requestInit });
    try {
      await client.connect(primary);
    } catch (err) {
      // fallback to SSE transport
      const fallback = new SSEClientTransport(baseUrl, { requestInit });
      await client.connect(fallback);
    }

    this.client = client;
    return client;
  }

  private async checkAuth(origin: string) {
    try {
      const res = await ky(`${origin}/.well-known/oauth-authorization-server`, {
        timeout: 3_000,
      });
      if (!res.ok) return { requiresAuth: false };
      const json = await res.json<any>();
      return {
        requiresAuth: true,
        metadata: json as Record<string, any>,
      };
    } catch {
      return { requiresAuth: false };
    }
  }
}
