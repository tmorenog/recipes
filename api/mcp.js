// MCP endpoint (Streamable HTTP, stateless) at /api/mcp.
// Agents send their group key: Authorization: Bearer <group key>
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../lib/mcp.js';
import { groupFromRequest, unauthorized } from '../lib/groups.js';

export async function handle(request) {
  const group = groupFromRequest(request);
  if (!group) {
    const { status, error } = unauthorized();
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: error }, id: null }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  const server = createMcpServer(group);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: each request stands alone, which suits serverless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST = (request) => handle(request);
export const GET = (request) => handle(request);
export const DELETE = (request) => handle(request);
