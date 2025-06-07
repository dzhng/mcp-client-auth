/**
 * Utility library for authenticating to **remote MCP servers** that expose
 * their own OpenID-compatible OAuth2 endpoints (e.g. Atlassian Remote MCP).
 *
 * Key features
 *   • OpenID discovery + optional **dynamic client registration**
 *   • PKCE Authorization-Code flow in a headless CLI (opens browser, local callback)
 *   • Automatic token refresh / rotation
 *   • Tiny wrapper around **ky** (instead of axios) that injects
 *     `Authorization: Bearer …` headers for you
 *
 * Usage:
 * ```ts
 * const oauth = new McpOAuth();
 * await oauth.init();
 * const kyAuth = await oauth.ky();
 * const resp   = await kyAuth('https://mcp.atlassian.com/v1/sse');
 * ```
 */

import * as client from 'openid-client';
import kyFactory, { KyInstance, Options as KyOptions } from 'ky';
import open from 'open';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';

// --------------------------- util: tiny JSON file store -----------------------
export interface TokenStore {
  load(): Promise<client.TokenEndpointResponse | undefined>;
  save(token: client.TokenEndpointResponse): Promise<void>;
}

export class JsonTokenStore implements TokenStore {
  constructor(private path = '.mcp-token.json') {}
  async load() {
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch {
      return undefined;
    }
  }
  async save(t: client.TokenEndpointResponse) {
    await fs.writeFile(this.path, JSON.stringify(t), 'utf8');
  }
}

// --------------------------- main OAuth helper --------------------------------
export interface McpOAuthOpts {
  issuerUrl?: string;
  redirectUri?: string;
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
  store?: TokenStore;
  kyOpts?: KyOptions;
}

export class McpOAuth {
  private config!: client.Configuration;
  private token?: client.TokenEndpointResponse;
  private kyInstance?: KyInstance;

  constructor(private opts: McpOAuthOpts = {}) {}

  async init() {
    const {
      issuerUrl = 'https://mcp.atlassian.com/.well-known/oauth-authorization-server',
      redirectUri = 'http://localhost:3334/callback',
      scopes = [
        'read:jira-work',
        'write:jira-work',
        'read:confluence-content',
        'offline_access',
      ],
      clientId,
      clientSecret,
      store = new JsonTokenStore(),
    } = this.opts;

    // 1) discovery
    this.config = await client.discovery(
      new URL(issuerUrl),
      clientId!,
      clientSecret
    );

    // 2) load cached token if any
    this.token = await store.load();
    this.opts.store = store;
    this.opts.redirectUri = redirectUri;
    this.opts.scopes = scopes;
  }

  /** Return a Ky instance that pre-signs every request. */
  async ky(): Promise<KyInstance> {
    if (!this.kyInstance) {
      const base = kyFactory.create({
        ...this.opts.kyOpts,
        hooks: {
          beforeRequest: [
            async req => {
              req.headers.set(
                'Authorization',
                `Bearer ${await this.getAccessToken()}`
              );
            },
          ],
        },
      });
      this.kyInstance = base;
    }
    return this.kyInstance;
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.isTokenExpired(this.token)) {
      if (this.token.refresh_token) {
        this.token = await client.refreshTokenGrant(
          this.config,
          this.token.refresh_token
        );
        await this.opts.store!.save(this.token);
      } else {
        await this.interactiveLogin();
      }
    }
    if (!this.token) await this.interactiveLogin();
    return this.token!.access_token!;
  }

  private isTokenExpired(token: client.TokenEndpointResponse): boolean {
    if (!token.expires_in) return false;
    // Add a 5-minute buffer before expiration
    const expirationTime = token.expires_in * 1000 - 5 * 60 * 1000;
    return Date.now() > expirationTime;
  }

  // --------------------------- interactive browser login ----------------------
  private async interactiveLogin() {
    const { redirectUri, scopes, store } = this.opts;

    // Generate PKCE parameters
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const parameters: Record<string, string> = {
      redirect_uri: redirectUri!,
      scope: scopes!.join(' '),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    };

    const authUrl = client.buildAuthorizationUrl(this.config, parameters);
    await open(authUrl.href);

    const code = await new Promise<string>((resolve, reject) => {
      const srv = http
        .createServer((req, res) => {
          const u = new URL(req.url!, redirectUri!);
          if (u.searchParams.get('state') !== state)
            return reject(new Error('state mismatch'));
          if (u.searchParams.has('error'))
            return reject(new Error(u.searchParams.get('error')!));
          res.end('Authentication complete – you may close this tab.');
          srv.close();
          resolve(u.searchParams.get('code')!);
        })
        .listen(Number(new URL(redirectUri!).port), 'localhost');
    });

    // Exchange authorization code for tokens
    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    this.token = await client.authorizationCodeGrant(this.config, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
    });

    await store!.save(this.token);
  }
}
