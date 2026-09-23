// Vercel function serving the MCP endpoint (Streamable HTTP, stateless).
// Agents connect to https://<your-app>.vercel.app/mcp with the header
//   Authorization: Bearer <MCP_API_KEY>
// and optionally  X-Caller: <team or agent name>  (recorded in the audit log).
import { timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../lib/server.js';
import { supabaseDb } from '../lib/db.js';

let db;

const deny = (status, message) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function authorized(request, expected) {
  const header = request.headers.get('authorization') || '';
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function handle(request, { getDb = () => (db ??= supabaseDb()) } = {}) {
  const key = process.env.MCP_API_KEY;
  if (!key) return deny(500, 'MCP_API_KEY is not set on the server.');
  if (!authorized(request, key)) return deny(401, 'Missing or wrong API key. Send Authorization: Bearer <key>.');

  const caller = (request.headers.get('x-caller') || 'unknown').trim().slice(0, 60) || 'unknown';
  const server = createMcpServer({ db: getDb(), caller });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: every request stands alone, which suits serverless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST = (request) => handle(request);
export const GET = (request) => handle(request);
export const DELETE = (request) => handle(request);
