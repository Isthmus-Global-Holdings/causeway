// POST /mcp — the Claude connector (a remote MCP server). OAuthProvider
// (src/worker.ts) only hands a request here once its bearer token checks out,
// with the props the rep approved it with (routes/authorize.ts): the rep's
// email is the actor on everything the tools do, as the Access JWT is on the
// pages. Stateless: each request gets a fresh server, so nothing is kept
// between calls.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { Hono } from 'hono';
import { timing } from '../middleware/timing';
import type { AppEnv } from '../types';
import { INSTRUCTIONS, registerTools } from './tools';

// What routes/authorize.ts stores with each grant.
export interface ConnectorProps {
  actor: string; // the rep's email, from Cloudflare Access
}

export const mcpApp = new Hono<AppEnv>();

mcpApp.use('*', timing);

mcpApp.use('*', async (c, next) => {
  const { props } = c.executionCtx as ExecutionContext & { props?: Partial<ConnectorProps> };
  if (!props?.actor) return c.text('Unauthorized', 401);
  c.set('actor', props.actor);
  return next();
});

mcpApp.all('/mcp', async (c) => {
  const server = new McpServer(
    { name: 'causeway', title: 'Causeway', version: '1.0.0' },
    { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
  );
  registerTools(server, c);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

mcpApp.onError((err, c) => {
  console.error(err);
  return c.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }, 500);
});
