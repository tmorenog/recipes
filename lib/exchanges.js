// The coordinator's exchange log: every MCP request an agent sends and the
// answer it gets, plus the Pricer's results, for the Coordinator page.
// Headers are never logged, so the class key never is. Large answers are
// trimmed; only the newest 2,000 entries are kept (lib/store/postgres.js).
import { getStore } from './store/index.js';
import { redact } from './secrets.js';

const QUIET = new Set(['initialize', 'notifications/initialized', 'ping']);
const MAX_JSON = 6000;

// Which agent a tool belongs to, when the request didn't say (?agent=).
const TOOL_AGENT = {
  save_recipe: 'scout',
  mark_processed: 'planner',
  check_meal_plan: 'planner',
  save_meal_plan: 'planner',
};

const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '?');
const cut = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Long strings (recipe instructions) and long lists are shortened so a row stays small.
function trim(value, depth = 0) {
  if (typeof value === 'string') return cut(redact(value), 400);
  if (Array.isArray(value)) {
    const items = value.slice(0, 25).map((v) => trim(v, depth + 1));
    return value.length > 25 ? [...items, `… and ${value.length - 25} more`] : items;
  }
  if (value && typeof value === 'object') {
    if (depth > 5) return '…';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v, depth + 1)]));
  }
  return value;
}
function small(value) {
  if (value === undefined) return null;
  const t = trim(value);
  const text = JSON.stringify(t);
  return text.length <= MAX_JSON ? t : { trimmed: true, preview: `${text.slice(0, MAX_JSON)}…` };
}

// What a tool answered: JSON when it's JSON, otherwise the text.
function toolText(result) {
  const text = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function requestSummary(tool, args = {}) {
  if (tool === 'save_recipe') return [args.name, args.meal_id && `meal ${args.meal_id}`, args.theme && `for “${args.theme}”`].filter(Boolean).join(', ');
  if (tool === 'check_meal_plan' || tool === 'save_meal_plan') {
    const n = Array.isArray(args.meals) ? args.meals.length : 0;
    return `${n} dinner${n === 1 ? '' : 's'}${args.budget_usd != null ? `, budget ${money(args.budget_usd)}` : ''}`;
  }
  const keys = Object.entries(args || {}).filter(([, v]) => v != null);
  return keys.length ? cut(keys.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', '), 100) : '';
}

function answerSummary(tool, json, text) {
  if (!json) return cut(text.replace(/^Rejected:\n- /, '').replace(/\n- /g, '; '), 220);
  switch (tool) {
    case 'get_expectations':
      return `the ${json.agent || 'agent'}’s brief: goal, ${json.steps?.length ?? 0} steps, ${(json.rules || json.balance_rules?.rules || []).length} rules and the format`;
    case 'save_recipe':
      return json.new_recipe ? 'saved, a new recipe' : `saved: already chosen by another group, now picked by ${json.picked_by?.length ?? '?'} groups`;
    case 'list_recipes':
      return `${json.count} recipe${json.count === 1 ? '' : 's'}`;
    case 'check_meal_plan':
    case 'save_meal_plan': {
      const checks = json.checks || [];
      const passed = checks.filter((c) => c.passed).length;
      return `${json.saved ? 'saved: ' : ''}${money(json.week_cost_per_person_usd)} per person; ${passed} of ${checks.length} rules pass`;
    }
    case 'mark_processed':
      return json.note ? `already processed (${json.note})` : 'marked processed';
    default:
      return json.count != null ? `${json.count} result${json.count === 1 ? '' : 's'}` : 'done';
  }
}

// One JSON-RPC request and its response, as sent to /api/mcp.
export function describe(message, response, { agent = null } = {}) {
  const method = message?.method;
  if (!method || QUIET.has(method)) return null;
  const error = response?.error;
  if (method === 'tools/list') {
    const names = (response?.result?.tools || []).map((t) => t.name);
    return {
      agent, method, tool: null, ok: !error,
      request: null,
      response: error ? small(error) : { tools: names },
      summary: error ? cut(error.message || 'error') : `${names.length} tools: ${names.join(', ')}`,
    };
  }
  if (method === 'tools/call') {
    const tool = String(message.params?.name ?? '');
    const args = message.params?.arguments ?? {};
    if (error) {
      return { agent: agent || TOOL_AGENT[tool] || null, method, tool, ok: false, request: small(args), response: small(error), summary: cut(error.message || 'error'), request_summary: requestSummary(tool, args) };
    }
    const { json, text } = toolText(response?.result);
    const rejectedCall = Boolean(response?.result?.isError);
    return {
      agent: agent || TOOL_AGENT[tool] || null,
      method, tool, ok: !rejectedCall,
      request: small(args),
      response: rejectedCall ? { isError: true, text: cut(text, 2000) } : json ? small(json) : { text: cut(text, 2000) },
      summary: answerSummary(rejectedCall ? null : tool, rejectedCall ? null : json, text),
      request_summary: requestSummary(tool, args),
    };
  }
  return { agent, method, tool: null, ok: !error, request: small(message.params ?? null), response: small(error ?? response?.result ?? null), summary: error ? cut(error.message || 'error') : 'done' };
}

// Logging never breaks a request: a failure here is only reported.
export async function logExchange(entry) {
  try {
    await getStore().logExchange(entry);
  } catch (e) {
    console.error('exchange log failed:', e.message);
  }
}

// Logs every message in a JSON-RPC request (single or batch) with its response.
export async function logMcp({ body, responseBody, group, agent, ms }) {
  const messages = Array.isArray(body) ? body : [body];
  const responses = Array.isArray(responseBody) ? responseBody : responseBody ? [responseBody] : [];
  const byId = new Map(responses.filter((r) => r && r.id != null).map((r) => [r.id, r]));
  for (const m of messages) {
    const d = describe(m, byId.get(m?.id) ?? (messages.length === 1 ? responses[0] : null), { agent });
    if (d) await logExchange({ ...d, group_name: group, ms });
  }
}
