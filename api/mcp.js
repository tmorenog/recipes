// MCP endpoint (Streamable HTTP, stateless) at /api/mcp, or
// /api/mcp?agent=scout|planner for one agent's tools only.
// Agents send the class key and their group name:
//   Authorization: Bearer <class key>
//   X-Group: <group name>
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../lib/mcp.js';
import { checkCaller } from '../lib/auth.js';
import { AGENTS } from '../lib/contract.js';
import { logMcp } from '../lib/exchanges.js';

const fail = (status, message) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// This server is stateless: each POST stands alone and every answer is plain
// JSON (enableJsonResponse). There is no stream to open, so GET and DELETE are
// refused at once; MCP clients expect that and carry on with POSTs.
const postOnly = () =>
  new Response(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This coordinator only answers POST requests: send each MCP request as a POST with a JSON body. (It is stateless, so there is no stream to open.)' },
    id: null,
  }), { status: 405, headers: { 'content-type': 'application/json', allow: 'POST' } });

// Hand-written code often gets the wrapping slightly wrong. Fix what is certain:
// a JSON body sent without the JSON content type (fetch sends text/plain),
// tool arguments sent as a JSON string, and a missing or partial Accept header
// (the spec asks for both types; many clients send one or none).
async function tidy(request) {
  const text = await request.text();
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json, text/event-stream');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: passed on as it is, with the right headers, so the answer is a parse error.
    return { request: new Request(request.url, { method: 'POST', headers, body: text }), body: null };
  }
  for (const m of Array.isArray(body) ? body : [body]) {
    if (m?.method === 'tools/call' && typeof m.params?.arguments === 'string') {
      try { m.params.arguments = JSON.parse(m.params.arguments); } catch { /* left as sent: rejected with a reason */ }
    }
    // The tool's earlier name, for agents built before it was renamed.
    if (m?.method === 'tools/call' && m.params?.name === 'get_expectations') m.params.name = 'get_contract';
  }
  return { request: new Request(request.url, { method: 'POST', headers, body: JSON.stringify(body) }), body };
}

export async function handle(request) {
  if (request.method !== 'POST') return postOnly();
  const { group, status, error } = checkCaller(request);
  if (error) return fail(status, error);
  const agent = (new URL(request.url).searchParams.get('agent') || '').trim().toLowerCase() || null;
  if (agent && !AGENTS.includes(agent)) return fail(400, `?agent= must be one of: ${AGENTS.join(', ')}`);
  const server = createMcpServer(group, { agent });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: each request stands alone, which suits serverless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const started = Date.now();
  const { request: tidied, body } = await tidy(request);
  const response = await transport.handleRequest(tidied);
  // Keep a copy of what was asked and answered, for the Coordinator page's exchange log.
  if (body) {
    const responseBody = await response.clone().json().catch(() => null);
    await logMcp({ body, responseBody, group, agent, ms: Date.now() - started });
  }
  // Says back the group on every answer too, for apps that check the connection over plain HTTP.
  const headers = new Headers(response.headers);
  if (group) headers.set('X-Coordinator-Group', group);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const POST = (request) => handle(request);
export const GET = (request) => handle(request);
export const DELETE = (request) => handle(request);
