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
  oauth?: McpOAuth; // optional – will be auto-initialised on demand
}

export class McpClient {
  private clients = new Map<string, MCP>();
  private oauth?: McpOAuth;

  constructor(private opts: McpClientOptions = {}) {
    this.oauth = opts.oauth;
  }

  // ------------------------- public high-level helpers ------------------------
  async getServer(url: string): Promise<MCP> {
    return this.connect(url);
  }

  async listTools(serverUrl: string): Promise<McpTool[]> {
    const c = await this.getServer(serverUrl);
    const resp = await c.listTools();
    return resp.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    }));
  }

  async callTool(serverUrl: string, name: string, args: any) {
    const c = await this.getServer(serverUrl);
    return c.callTool({ name, arguments: args });
  }

  async disconnect(serverUrl: string) {
    const c = this.clients.get(serverUrl);
    if (c) {
      await c.close();
      this.clients.delete(serverUrl);
    }
  }

  async disconnectAll() {
    const urls = Array.from(this.clients.keys());
    for (const url of urls) await this.disconnect(url);
  }

  // -------------------------- internal connection logic ----------------------
  private async connect(serverUrl: string): Promise<MCP> {
    if (this.clients.has(serverUrl)) return this.clients.get(serverUrl)!;

    if (!serverUrl.startsWith('https://'))
      throw new Error('MCP servers must be HTTPS');
    const baseUrl = new URL(serverUrl);

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

    this.clients.set(serverUrl, client);
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

// ------------------------- convenience singleton -----------------------------
export const mcpClient = new McpClient();
