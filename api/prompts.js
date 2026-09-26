// Every prompt, in two sets, both stored in the database:
//   current   "live": what students see and agents use: the instructor's edit, or else the default
//   default   "the safe copy", restored in case of error: the instructor's replacement, or else
//             the original (the students' steps: public/prompts/{agent}/step-{n}.txt; the
//             Pricer: lib/pricer.js; the Shopper and backup agents: lib/backup-agents.js)
// Agents: scout, planner (steps 1-20), pricer, backup_scout, backup_planner, shopper (step 1).
//
//   GET  /api/prompts?agent=…    { steps: {n: current edit}, updated_at, defaults: {n: replaced or
//                                code default}, defaults_replaced: {n: true} }              (anyone)
//   POST /api/prompts            with Authorization: Bearer <ADMIN_KEY>
//        {"agent", "step", "text"}                  saves a current prompt
//        {"agent", "step", "reset": true}           the current prompt goes back to the default
//        {"set": "default", "agent", "step", "text"}          replaces the default
//        {"set": "default", "agent", "step", "reset": true}   back to the original default
//        {"set": "current"|"default", "prompts": [{"agent", "step", "text"}, …]}   several at once
import { z } from 'zod';
import { getStore } from '../lib/store/index.js';
import { checkAdmin } from '../lib/admin.js';
import { json, guarded } from '../lib/http.js';
import { SITE_PROMPTS } from '../lib/backup-agents.js';
import { DEFAULT_PROMPT } from '../lib/pricer.js';

const agent = z.enum(['scout', 'planner', 'pricer', 'backup_scout', 'backup_planner', 'shopper']);
const step = z.number().int().min(1).max(20);
const PLACEHOLDERS = ['SITE', 'GROUP'];
const CODE_DEFAULTS = { ...SITE_PROMPTS, pricer: DEFAULT_PROMPT };
const STUDENT = new Set(['scout', 'planner']);

// The current edits: the Pricer keeps its own (pricer_config), the others prompt_overrides.
async function currentEdits(store, a) {
  if (a === 'pricer') {
    const text = await store.getPricerConfig('prompt');
    return text ? [{ step: 1, text, updated_at: null }] : [];
  }
  return store.listPromptOverrides(a);
}
async function setCurrent(store, a, n, text) {
  if (a === 'pricer') return store.setPricerConfig('prompt', text);
  return store.setPromptOverride(a, n, text);
}

export const GET = guarded(async (request) => {
  const parsed = agent.safeParse(new URL(request.url).searchParams.get('agent'));
  if (!parsed.success) return json(400, { errors: [`agent must be one of: ${agent.options.join(', ')}`] });
  const a = parsed.data;
  const store = getStore();
  const [rows, replaced] = await Promise.all([currentEdits(store, a), store.listPromptDefaults(a)]);
  const defaults = Object.fromEntries(replaced.map((r) => [r.step, r.text]));
  if (CODE_DEFAULTS[a] && !defaults[1]) defaults[1] = CODE_DEFAULTS[a];
  return json(200, {
    agent: a,
    steps: Object.fromEntries(rows.map((r) => [r.step, r.text])),
    updated_at: Object.fromEntries(rows.map((r) => [r.step, r.updated_at])),
    defaults,
    defaults_replaced: Object.fromEntries(replaced.map((r) => [r.step, true])),
  });
});

function check(a, n, raw) {
  if (!STUDENT.has(a) && n !== 1) return `${a} has one prompt: step 1`;
  const text = (raw ?? '').trim();
  if (text.length < 20) return 'The prompt is too short (at least 20 characters).';
  if (text.length > 20000) return 'The prompt is too long (at most 20,000 characters).';
  const found = [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
  if (!STUDENT.has(a) && found.length) return `The agents’ instructions have no placeholders: remove ${found.map((k) => `{{${k}}}`).join(', ')}.`;
  const unknown = found.filter((k) => !PLACEHOLDERS.includes(k));
  if (unknown.length) return `Unknown placeholder ${unknown.map((k) => `{{${k}}}`).join(', ')}: only {{SITE}} and {{GROUP}} are filled in.`;
  return null;
}

export const POST = guarded(async (request) => {
  const auth = checkAdmin(request);
  if (!auth.ok) return json(auth.status, { errors: [auth.error] });
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { errors: ['The request body must be JSON.'] });
  }
  const one = z.object({ agent, step, text: z.string().optional(), reset: z.boolean().optional() });
  const parsed = z.union([
    one.extend({ set: z.enum(['current', 'default']).optional() }),
    z.object({ set: z.enum(['current', 'default']), prompts: z.array(z.object({ agent, step, text: z.string() })).min(1).max(40) }),
  ]).safeParse(body);
  if (!parsed.success) return json(400, { errors: [`Send {"agent": ${agent.options.map((x) => `"${x}"`).join(' | ')}, "step", "text"} or {…, "reset": true}, with "set": "default" for the defaults; or {"set", "prompts": [{"agent", "step", "text"}, …]}.`] });
  const store = getStore();
  const toDefault = parsed.data.set === 'default';
  const write = (a, n, text) => (toDefault ? store.setPromptDefault(a, n, text) : setCurrent(store, a, n, text));

  if (parsed.data.prompts) {
    const errors = parsed.data.prompts.map((p) => { const e = check(p.agent, p.step, p.text); return e && `${p.agent} ${p.step}: ${e}`; }).filter(Boolean);
    if (errors.length) return json(400, { errors: ['Nothing was saved.', ...errors] });
    for (const p of parsed.data.prompts) await write(p.agent, p.step, p.text.trim());
    return json(200, { saved: parsed.data.prompts.length, set: toDefault ? 'default' : 'current' });
  }
  const { agent: a, step: n, text, reset } = parsed.data;
  if (reset) {
    await write(a, n, null);
    return json(200, { saved: true, reset: true, set: toDefault ? 'default' : 'current' });
  }
  const error = check(a, n, text);
  if (error) return json(400, { errors: [error] });
  await write(a, n, text.trim());
  return json(200, { saved: true, text: text.trim(), set: toDefault ? 'default' : 'current' });
});
