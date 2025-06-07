/**
 * MCP Kit - OAuth-enabled MCP client library
 *
 * @example Basic usage with OAuth:
 * ```typescript
 * import { McpClient } from 'mcp-kit';
 *
 * const client = new McpClient({ url: 'https://mcp.example.com' });
 *
 * // Check if auth is required
 * if (await client.isAuthRequired()) {
 *   const oauth = await client.getOAuth();
 *
 *   // Generate auth URL
 *   const authRequest = await oauth.createAuthorizationRequest();
 *   console.log('Visit:', authRequest.url);
 *
 *   // After user authorizes, exchange code for token
 *   const token = await oauth.exchangeCodeForToken(code, state, authRequest.codeVerifier);
 * }
 *
 * // Use the client normally - auth is handled automatically
 * const tools = await client.listTools();
 * const result = await client.callTool('search', { query: 'example' });
 * ```
 *
 * @example Direct OAuth usage:
 * ```typescript
 * import { McpOAuth } from 'mcp-kit';
 *
 * const oauth = new McpOAuth({
 *   serverUrl: 'https://mcp.example.com',
 *   store: new CustomTokenStore() // Optional custom storage
 * });
 *
 * await oauth.init();
 * const authRequest = await oauth.createAuthorizationRequest();
 * // ... handle OAuth flow ...
 *
 * // Use authenticated Ky client
 * const ky = await oauth.ky();
 * const data = await ky.get('api/data').json();
 * ```
 */

export * from './mcp-oauth.js';
export * from './mcp-client.js';
