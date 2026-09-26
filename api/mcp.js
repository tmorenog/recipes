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
import { krogerLimitFor } from '../lib/settings.js';

const MAX_BODY = 256 * 1024; // a request's size; a recipe is a few KB
const MAX_BATCH = 10; // messages in one JSON-RPC batch
const KROGER_TOOLS = new Set(['find_kroger_stores', 'search_kroger_products']);

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

// A tool call answered here, without the SDK: rejected with a reason, as the tools do.
const rejectedCall = (m, reason) => ({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Rejected:\n- ${reason}` }], isError: true } });
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Hand-written code often gets the wrapping slightly wrong. Fix what is certain:
// a JSON body sent without the JSON content type (fetch sends text/plain),
// tool arguments sent as a JSON string (or null), and a missing or partial
// Accept header (the spec asks for both types; many clients send one or none).
// Tool calls that can't go on (arguments that aren't an object, the Kroger
// limit) are answered here: { answered } holds those answers, and the rest go on.
async function tidy(request, text, group) {
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json, text/event-stream');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: passed on as it is, with the right headers, so the answer is a parse error.
    return { request: new Request(request.url, { method: 'POST', headers, body: text }), body: null, answered: [] };
  }
  if (Array.isArray(body) && body.length > MAX_BATCH) return { tooMany: true };
  const answered = [];
  const rest = [];
  for (const m of Array.isArray(body) ? body : [body]) {
    let answer = null;
    if (m?.method === 'tools/call' && isObject(m.params)) {
      const args = m.params.arguments;
      if (typeof args === 'string') {
        try { m.params.arguments = JSON.parse(args); } catch { /* not JSON: rejected below */ }
      }
      if (m.params.arguments === null) delete m.params.arguments; // the same as none
      if (m.params.arguments !== undefined && !isObject(m.params.arguments)) answer = rejectedCall(m, 'arguments must be a JSON object, e.g. {"theme": "…"}');
      // The tool's earlier name, for agents built before it was renamed.
      if (m.params.name === 'get_expectations') m.params.name = 'get_contract';
      if (!answer && KROGER_TOOLS.has(m.params.name)) {
        const limited = await krogerLimitFor(group);
        if (limited) answer = rejectedCall(m, limited.errors.join('; '));
      }
    }
    if (answer) {
      if (m.id != null) answered.push(answer); // a notification gets no answer
    } else rest.push(m);
  }
  const forward = Array.isArray(body) ? rest : rest[0];
  return { request: forward && (!Array.isArray(forward) || forward.length) ? new Request(request.url, { method: 'POST', headers, body: JSON.stringify(forward) }) : null, body, answered };
}

const jsonAnswer = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function answer(request) {
  if (request.method !== 'POST') return postOnly();
  const { group, site, status, error } = checkCaller(request);
  if (error) return fail(status, error);
  const agent = (new URL(request.url).searchParams.get('agent') || '').trim().toLowerCase() || null;
  if (agent && !AGENTS.includes(agent)) return fail(400, `?agent= must be one of: ${AGENTS.join(', ')}`);
  const tooLarge = `The request is too large: at most ${MAX_BODY / 1024} KB. Send less at once.`;
  if (Number(request.headers.get('content-length')) > MAX_BODY) return fail(413, tooLarge);
  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, tooLarge);
  const started = Date.now();
  const { request: tidied, body, answered, tooMany } = await tidy(request, text, group);
  if (tooMany) return fail(400, `A batch can hold at most ${MAX_BATCH} requests: send the rest separately.`);
  const server = createMcpServer(group, { agent, site });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: each request stands alone, which suits serverless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  let response = tidied ? await transport.handleRequest(tidied) : null;
  // Answers made here go with the SDK's (a batch gets one list).
  if (answered.length) {
    const sdk = response && response.status !== 202 ? await response.json().catch(() => null) : null;
    const all = [...answered, ...(Array.isArray(sdk) ? sdk : sdk ? [sdk] : [])];
    response = jsonAnswer(Array.isArray(body) ? all : all[0]);
  }
  if (!response) response = new Response(null, { status: 202 }); // only notifications, all answered here
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

// Anything unexpected (e.g. JSON nested too deeply to handle) is answered
// with a readable JSON-RPC error rather than a crash.
export async function handle(request) {
  try {
    return await answer(request);
  } catch (e) {
    console.error('MCP:', e);
    if (e instanceof SyntaxError || e instanceof RangeError) return fail(400, 'The request couldn’t be read: send one JSON-RPC message (or a short list of them) as plain JSON.');
    return fail(500, 'Something went wrong on the coordinator. Try again; if it keeps happening, tell the instructor.');
  }
}

export const POST = (request) => handle(request);
export const GET = (request) => handle(request);
export const DELETE = (request) => handle(request);
