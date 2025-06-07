#!/usr/bin/env node

/**
 * Test script for Atlassian's MCP server with OAuth support
 * Usage: npx tsx test-atlassian.ts
 */
import * as http from 'node:http';
import open from 'open';

import { McpClient } from './src/mcp-client';
import { AuthorizationRequest } from './src/mcp-oauth';

const REMOTE_MCP_URL = 'https://mcp.linear.app/sse';

/**
 * Handle OAuth authentication flow
 */
async function handleOAuthFlow(
  mcpClient: McpClient,
  authRequest: AuthorizationRequest,
): Promise<void> {
  const oauth = await mcpClient.getOAuth();
  if (!oauth) {
    throw new Error('OAuth instance not available');
  }

  console.log('🔐 Authentication required. Starting OAuth flow...');

  console.log(`🌐 Opening browser for authentication...`);
  console.log(`   If browser doesn't open, visit: ${authRequest.url}`);

  // Open browser
  await open(authRequest.url);

  // Start local server to receive callback
  const code = await waitForOAuthCallback(authRequest.state);

  // Exchange code for token
  console.log('🔄 Exchanging authorization code for token...');
  console.log(`📝 Received authorization code: ${code}`);
  await oauth.exchangeCodeForToken(
    code,
    authRequest.state,
    authRequest.codeVerifier,
  );
  console.log('✅ Authentication successful!');
}

/**
 * Wait for OAuth callback on local server
 */
function waitForOAuthCallback(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost:3334');

      // Validate state parameter
      const state = url.searchParams.get('state');
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body>
              <h1>Authentication Error</h1>
              <p>Invalid state parameter. Please try again.</p>
            </body>
          </html>
        `);
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }

      // Check for OAuth error
      const error = url.searchParams.get('error');
      if (error) {
        const errorDesc = url.searchParams.get('error_description') || error;
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body>
              <h1>Authentication Error</h1>
              <p>${errorDesc}</p>
            </body>
          </html>
        `);
        server.close();
        reject(new Error(`OAuth error: ${errorDesc}`));
        return;
      }

      // Get authorization code
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body>
              <h1>Authentication Error</h1>
              <p>Missing authorization code.</p>
            </body>
          </html>
        `);
        server.close();
        reject(new Error('Missing authorization code'));
        return;
      }

      // Success response
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body>
            <h1>Authentication Successful!</h1>
            <p>You can close this window and return to your terminal.</p>
            <script>window.close();</script>
          </body>
        </html>
      `);

      server.close();
      resolve(code);
    });

    server.listen(3334, 'localhost', () => {
      console.log('📡 Listening for OAuth callback on http://localhost:3334');
    });

    // Timeout after 5 minutes
    setTimeout(
      () => {
        server.close();
        reject(new Error('OAuth callback timeout'));
      },
      5 * 60 * 1000,
    );
  });
}

async function testRemoteMcp() {
  console.log('🚀 Testing Remote MCP server...');
  console.log(`📡 Server URL: ${REMOTE_MCP_URL}`);

  const mcpClient = new McpClient({
    url: REMOTE_MCP_URL,
    // You can provide pre-registered client credentials here if you have them
    // clientId: 'your-client-id',
    // clientSecret: 'your-client-secret',
  });

  try {
    // Check if authentication is required
    const authStatus = await mcpClient.isAuthRequired();

    if (!authStatus.isAuthenticated) {
      // This can only happen when isRequired is true and isAuthenticated is false
      await handleOAuthFlow(mcpClient, authStatus.authorizationRequest);
    } else if (!authStatus.isRequired) {
      console.log('✅ No authentication required');
    } else {
      console.log('✅ Using existing valid token');
    }

    // Test connection
    console.log('\n📋 Connecting to server...');
    // Usually this doesn't need to be called (mcpClient will automatically call it), but it's here just so we can log that it successfully connected
    await mcpClient.getServer();
    console.log('✅ Successfully connected to server');

    // List available tools
    console.log('\n📋 Listing available tools...');
    const tools = await mcpClient.listTools();

    if (tools.length === 0) {
      console.log('⚠️  No tools found');
    } else {
      console.log(`✅ Found ${tools.length} tool(s):`);
      tools.forEach((tool, index) => {
        console.log(`\n  ${index + 1}. ${tool.name}`);
        if (tool.description) {
          console.log(`     Description: ${tool.description}`);
        }
        console.log(
          `     Input Schema:`,
          JSON.stringify(tool.inputSchema, null, 2),
        );
        if (tool.outputSchema) {
          console.log(
            `     Output Schema:`,
            JSON.stringify(tool.outputSchema, null, 2),
          );
        }
      });
    }

    // Test a simple tool call if tools are available
    if (tools.length > 0) {
      const firstTool = tools[0];
      console.log(`\n🔧 Testing tool call: ${firstTool.name}`);

      // Create minimal arguments based on input schema
      const args = createMinimalArgs(firstTool.inputSchema);
      console.log('   Arguments:', JSON.stringify(args, null, 2));

      try {
        const result = await mcpClient.callTool(firstTool.name, args);
        console.log('✅ Tool call successful:');
        console.log(JSON.stringify(result, null, 2));
      } catch (error: any) {
        console.log('⚠️  Tool call failed:', error.message);
      }
    }
  } catch (error: any) {
    console.error('\n❌ Error testing Remote MCP server:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
  } finally {
    // Clean up connection
    await mcpClient.disconnect();
    console.log('\n🔌 Disconnected from server');
  }
}

function createMinimalArgs(inputSchema: any): any {
  if (!inputSchema || !inputSchema.properties) {
    return {};
  }

  const args: any = {};

  // Add required properties with default values
  if (inputSchema.required) {
    for (const prop of inputSchema.required) {
      const propSchema = inputSchema.properties[prop];
      if (propSchema) {
        switch (propSchema.type) {
          case 'string':
            args[prop] = propSchema.default || 'test';
            break;
          case 'number':
            args[prop] = propSchema.default || 0;
            break;
          case 'boolean':
            args[prop] = propSchema.default || false;
            break;
          case 'array':
            args[prop] = propSchema.default || [];
            break;
          case 'object':
            args[prop] = propSchema.default || {};
            break;
          default:
            args[prop] = null;
        }
      }
    }
  }

  return args;
}

// Run the test
testRemoteMcp().catch(console.error);
