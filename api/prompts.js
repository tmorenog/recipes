// Prompts the instructor edited (on the Admin page, or on the Recipe Scout and
// Meal Planner pages). Student steps without an edit show their text file,
// public/prompts/{agent}/step-{n}.txt. The site agents' instructions
// (backup_scout, backup_planner, shopper; step 1) default to lib/backup-agents.js.
//
//   GET  /api/prompts?agent=…                 the edited steps: { steps: { "2": "…" } }, and for a
//                                             site agent its default: { defaults: { "1": "…" } }   (anyone)
//   POST /api/prompts                         with Authorization: Bearer <ADMIN_KEY>
//        body {"agent": "scout", "step": 2, "text": "…"}    saves an edited prompt
//        body {"agent": "scout", "step": 2, "reset": true}   goes back to the text file
import { z } from 'zod';
import { getStore } from '../lib/store/index.js';
import { checkAdmin } from '../lib/admin.js';
import { json, guarded } from '../lib/http.js';
import { SITE_PROMPTS } from '../lib/backup-agents.js';

const agent = z.enum(['scout', 'planner', 'backup_scout', 'backup_planner', 'shopper']);
const step = z.number().int().min(1).max(20);
const PLACEHOLDERS = ['SITE', 'GROUP'];

export const GET = guarded(async (request) => {
  const parsed = agent.safeParse(new URL(request.url).searchParams.get('agent'));
  if (!parsed.success) return json(400, { errors: [`agent must be one of: ${agent.options.join(', ')}`] });
  const rows = await getStore().listPromptOverrides(parsed.data);
  return json(200, {
    agent: parsed.data,
    ...(SITE_PROMPTS[parsed.data] && { defaults: { 1: SITE_PROMPTS[parsed.data] } }),
    steps: Object.fromEntries(rows.map((r) => [r.step, r.text])),
    updated_at: Object.fromEntries(rows.map((r) => [r.step, r.updated_at])),
  });
});

export const POST = guarded(async (request) => {
  const auth = checkAdmin(request);
  if (!auth.ok) return json(auth.status, { errors: [auth.error] });
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { errors: ['The request body must be JSON.'] });
  }
  const parsed = z
    .object({ agent, step, text: z.string().optional(), reset: z.boolean().optional() })
    .safeParse(body);
  if (!parsed.success) return json(400, { errors: [`Send {"agent": ${agent.options.map((a) => `"${a}"`).join(' | ')}, "step": 1-20, "text": "…"} or {"agent", "step", "reset": true}.`] });
  const { agent: a, step: n, text, reset } = parsed.data;
  const store = getStore();
  if (reset) {
    await store.setPromptOverride(a, n, null);
    return json(200, { saved: true, reset: true });
  }
  const prompt = (text ?? '').trim();
  if (prompt.length < 20) return json(400, { errors: ['The prompt is too short (at least 20 characters).'] });
  if (prompt.length > 20000) return json(400, { errors: ['The prompt is too long (at most 20,000 characters).'] });
  const unknown = [...new Set([...prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((k) => !PLACEHOLDERS.includes(k)))];
  if (unknown.length) {
    return json(400, { errors: [`Unknown placeholder ${unknown.map((k) => `{{${k}}}`).join(', ')}: only {{SITE}} and {{GROUP}} are filled in.`] });
  }
  await store.setPromptOverride(a, n, prompt);
  return json(200, { saved: true, text: prompt });
});
