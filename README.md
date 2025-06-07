# MCP Client Auth

A TypeScript library providing OAuth2 authentication utilities for Model Context Protocol (MCP) clients. This library simplifies the process of adding OAuth authentication to MCP client implementations.

MCP OAuth is extra tricky because the dynamic client registration and metadata discovery steps are not supported by typical oauth implementations. This library simplifies everything to 2 function calls.

If you like this project, please consider starring it and giving me a follow on [X/Twitter](https://x.com/dzhng). This project is sponsored by [Aomni](https://aomni.com).

## Features

Key capabilities:

- 🔐 **Complete OAuth2 Flow**: Implements the standard OAuth2 authorization code flow with PKCE
- 🚀 **MCP Client Integration**: Drop-in OAuth support for MCP clients
- 📦 **Zero Configuration**: Automatic server metadata discovery and dynamic client registration
- 🔄 **Token Management**: Automatic token refresh and secure storage (via pluggable storage interface)
- 🎯 **TypeScript First**: Full type safety and IntelliSense support

### OAuth Authentication Process

The library handles the complete OAuth flow automatically:

1. **Server Discovery** 🔍 → Discovers OAuth endpoints via `/.well-known/oauth-authorization-server`
2. **Dynamic Registration** 📝 → Registers as a public client if no client ID is provided
3. **Authorization** 🔐 → Generates authorization URL with PKCE code challenge
4. **Token Exchange** 🔄 → Exchanges authorization code for access/refresh tokens
5. **Token Refresh** ♻️ → Automatically refreshes expired tokens when available

## Installation

```bash
npm install mcp-client-auth
```

## Quick Start

### Using the High-Level MCP Client

```typescript
import { McpClient } from 'mcp-client-auth';

const client = new McpClient({
  url: 'https://mcp.example.com',
});

function connect() {
  // Check if authentication is required
  const authStatus = await client.isAuthRequired();

  if (authStatus.isRequired && !authStatus.isAuthenticated) {
    console.log('Please visit:', authStatus.authorizationRequest.url);

    // ... REDIRECT USER ...
  }
}

function callback() {
  // After user authorizes, exchange code for token
  // Realistically - this would be in a different callback route
  const token = await client.handleAuthByCode(
    code,
    authStatus.authorizationRequest,
  );
}

function use() {
  // Use the client - auth is handled automatically
  const tools = await client.listTools();
  const result = await client.callTool('search', { query: 'example' });
}
```

### Using OAuth Directly

This is normally not needed - only do this if you have some custom auth logic you want to implement.

```typescript
import { McpOAuth } from 'mcp-client-auth';

// Create OAuth instance
const oauth = new McpOAuth({
  serverUrl: 'https://mcp.example.com',
  clientId: 'your-client-id', // Optional
  redirectUri: 'http://localhost:3334/callback', // Optional
});

// Initialize (discovers metadata, registers client if needed)
await oauth.init();

// Generate authorization URL with PKCE
const authRequest = await oauth.createAuthorizationRequest();
console.log('Visit:', authRequest.url);

// Exchange authorization code for tokens
const token = await oauth.exchangeCodeForToken(
  code,
  state,
  authRequest.codeVerifier,
);

// Get authenticated HTTP client
const ky = await oauth.ky();
const data = await ky.get('api/data').json();
```

## API Reference

### McpClient

High-level MCP client with integrated OAuth support.

```typescript
class McpClient {
  constructor(options: McpClientOptions);

  // Check if auth is required and get auth status
  isAuthRequired(): Promise<AuthStatus>;

  // Get OAuth instance for manual auth flow
  getOAuth(): Promise<McpOAuth | undefined>;

  // MCP operations
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: any): Promise<any>;
  disconnect(): Promise<void>;
}
```

### McpOAuth

Core OAuth2 implementation for MCP servers.

```typescript
class McpOAuth {
  constructor(options: McpOAuthOptions);

  // Initialize OAuth (required before use)
  init(): Promise<void>;

  // Check if server requires authentication
  checkAuthRequired(): Promise<boolean>;

  // OAuth flow methods
  createAuthorizationRequest(): Promise<AuthorizationRequest>;
  exchangeCodeForToken(
    code: string,
    state: string,
    codeVerifier: string,
  ): Promise<StoredToken>;

  // Token management
  getAccessToken(): Promise<string>;
  hasValidToken(): boolean;

  // Get authenticated HTTP client
  ky(): Promise<KyInstance>;

  // Reset tokens
  reset(clearStorage?: boolean): Promise<void>;
}
```

## Configuration Options

### McpClientOptions

```typescript
interface McpClientOptions {
  url: string; // MCP server URL
  oauth?: McpOAuth; // Pre-configured OAuth instance
  clientId?: string; // OAuth client ID
  clientSecret?: string; // OAuth client secret
  oauthRedirectUri?: string; // OAuth redirect URI
  protocolVersion?: string; // MCP protocol version
}
```

### McpOAuthOptions

```typescript
interface McpOAuthOptions {
  serverUrl: string; // MCP server URL
  clientId?: string; // Pre-registered client ID
  clientSecret?: string; // Client secret (for confidential clients)
  redirectUri?: string; // Default: 'http://localhost:3334/callback'
  store?: OAuthStore; // Token storage implementation
  kyOpts?: KyOptions; // Additional HTTP client options
  protocolVersion?: string; // Default: '2024-11-05'
}
```

## Token Storage

By default, tokens are stored in a local JSON file (`.mcp-oauth.json`). You can provide a custom storage implementation:

```typescript
interface OAuthStore {
  load(): Promise<StoredOAuthData | undefined>;
  save(data: StoredOAuthData): Promise<void>;
  clear(): Promise<void>;
}

// Example: Custom in-memory store
class MemoryStore implements OAuthStore {
  private data?: StoredOAuthData;

  async load() {
    return this.data;
  }
  async save(data: StoredOAuthData) {
    this.data = data;
  }
  async clear() {
    this.data = undefined;
  }
}

const oauth = new McpOAuth({
  serverUrl: 'https://mcp.example.com',
  store: new MemoryStore(),
});
```

## License

MIT License - feel free to use and modify as needed.
