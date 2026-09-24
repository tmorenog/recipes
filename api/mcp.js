// MCP endpoint (Streamable HTTP, stateless) at /api/mcp, or
// /api/mcp?agent=scout|planner for one agent's tools only.
// Agents send the class key and their group name:
//   Authorization: Bearer <class key>
//   X-Group: <group name>
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../lib/mcp.js';
import { checkCaller } from '../lib/auth.js';
import { AGENTS } from '../lib/expectations.js';

const fail = (status, message) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Every answer is plain JSON (enableJsonResponse), so a hand-written fetch works
// as well as an MCP client. The spec asks clients to accept both types; many
// hand-written ones send only one, or none, so fill it in rather than refuse.
function acceptBoth(request) {
  if (request.method !== 'POST') return request;
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('application/json') && accept.includes('text/event-stream')) return request;
  const headers = new Headers(request.headers);
  headers.set('accept', 'application/json, text/event-stream');
  return new Request(request, { headers });
}

export async function handle(request) {
  const { group, status, error } = checkCaller(request);
  if (error) return fail(status, error);
  const agent = new URL(request.url).searchParams.get('agent') || null;
  if (agent && !AGENTS.includes(agent)) return fail(400, `?agent= must be one of: ${AGENTS.join(', ')}`);
  const server = createMcpServer(group, { agent });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: each request stands alone, which suits serverless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(acceptBoth(request));
}

export const POST = (request) => handle(request);
export const GET = (request) => handle(request);
export const DELETE = (request) => handle(request);
