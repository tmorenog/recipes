// MCP endpoint (Streamable HTTP, stateless) at /api/mcp.
// Agents send the class key and their group name:
//   Authorization: Bearer <class key>
//   X-Group: <group name>
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../lib/mcp.js';
import { checkCaller } from '../lib/auth.js';

export async function handle(request) {
  const { group, status, error } = checkCaller(request);
  if (error) {
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
