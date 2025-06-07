#!/usr/bin/env node

/**
 * Test script for Atlassian's MCP server
 * Usage: npx tsx test-atlassian.ts
 */
import { McpClient } from './src/mcp-client.js';

const ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v1/sse';

const mcpClient = new McpClient({ url: ATLASSIAN_MCP_URL });

async function testAtlassianMcp() {
  console.log('🚀 Testing Atlassian MCP server...');
  console.log(`📡 Connecting to: ${ATLASSIAN_MCP_URL}`);

  try {
    // Test connection
    const server = await mcpClient.getServer();
    console.log('✅ Successfully connected to server');

    // List available tools
    console.log('\n📋 Listing available tools...');
    const tools = await mcpClient.listTools();

    if (tools.length === 0) {
      console.log('⚠️  No tools found');
    } else {
      console.log(`✅ Found ${tools.length} tool(s):`);
      tools.forEach((tool, index) => {
        console.log(`  ${index + 1}. ${tool.name}`);
        if (tool.description) {
          console.log(`     Description: ${tool.description}`);
        }
        console.log(
          `     Input Schema: ${JSON.stringify(tool.inputSchema, null, 2)}`,
        );
        if (tool.outputSchema) {
          console.log(
            `     Output Schema: ${JSON.stringify(tool.outputSchema, null, 2)}`,
          );
        }
        console.log();
      });
    }

    // Test a simple tool call if tools are available
    if (tools.length > 0) {
      const firstTool = tools[0];
      console.log(`🔧 Testing tool call: ${firstTool.name}`);

      // Create minimal arguments based on input schema
      const args = createMinimalArgs(firstTool.inputSchema);

      try {
        const result = await mcpClient.callTool(firstTool.name, args);
        console.log('✅ Tool call successful:');
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.log(
          '⚠️  Tool call failed (this may be expected if auth is required):',
        );
        console.log(error.message);
      }
    }
  } catch (error) {
    console.error('❌ Error testing Atlassian MCP server:');
    console.error(error.message);
    console.error('\nFull error:', error);
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
testAtlassianMcp().catch(console.error);
