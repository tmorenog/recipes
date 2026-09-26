// Agents run on the site: the instructor's backup Scout Agent and Meal Planner Agent
// (for when a group's Lovable app isn't working) and the Shopper Agent, which
// chooses the class's plan and has its Kroger cart built. They work the way the
// students' agents are asked to: they reach the coordinator only through MCP
// (tools/list, then the tools it offers, with the class key and a group name),
// so the coordinator checks and logs them exactly like any other agent.
// Each run happens in the background; its steps are saved as they happen.
import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { getStore } from './store/index.js';
import { handle as mcpHandle } from '../api/mcp.js';
import { callModel, pricerSettings } from './pricer.js';
import { createShopper, SHOPPER_TOOLS } from './shopper-agent.js';
import { normalizeGroup, classKeySet } from './auth.js';
import { redact } from './secrets.js';
import { setting } from './env.js';

export const LIMITS = { scout: 35, planner: 30, shopper: 40, runMs: 240_000 }; // actions per run; a function may run 5 minutes
const MEALDB = 'https://www.themealdb.com/api/json/v1/1';
const overrides = { model: null, fetch: null, background: true }; // tests only
export const setBackupForTests = (o) => Object.assign(overrides, o);
export const backupModel = (env = process.env) => setting(['BACKUP_MODEL'], env) || 'claude-opus-5';

// ------------------------------------------------------------------ input
const group = z.string().trim().min(1).max(40).describe('The group the agent works for, e.g. team-3');
export const startSchema = z.discriminatedUnion('agent', [
  z.strictObject({ agent: z.literal('scout'), group, theme: z.string().trim().min(1).max(200) }),
  z.strictObject({
    agent: z.literal('planner'),
    group,
    budget_usd: z.number().finite().positive().max(1000),
    requirements: z.string().trim().max(500).default(''),
    preferences: z.string().trim().max(500).default(''),
  }),
  z.strictObject({ agent: z.literal('shopper'), group: group.default('shopper'), people: z.number().int().min(1).max(1000).default(50) }),
]);

export function backupProblem() {
  if (!classKeySet()) return 'The backup agents need CLASS_KEY: the instructor should add it in Vercel.';
  if (!pricerSettings().aiKey && !overrides.model) return 'The backup agents need an AI key: the instructor should add ANTHROPIC_API_KEY in Vercel.';
  return null;
}

// ------------------------------------------------------------------ the coordinator, over MCP
// Calls the MCP endpoint in-process, with the same headers a Lovable app sends.
function coordinator(agent, groupName) {
  let id = 0;
  const rpc = async (method, params) => {
    const res = await mcpHandle(new Request(`http://coordinator/api/mcp?agent=${agent}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.CLASS_KEY.trim()}`,
        'x-group': groupName,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    }));
    const body = await res.json().catch(() => null);
    if (!body || body.error) throw new Error(body?.error?.message || `the coordinator answered ${res.status}`);
    return body.result;
  };
  return {
    tools: async () => (await rpc('tools/list', {})).tools,
    call: async (name, args) => {
      const result = await rpc('tools/call', { name, arguments: args });
      const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { text, isError: Boolean(result.isError) };
    },
  };
}

// ------------------------------------------------------------------ TheMealDB (the Scout Agent's own tools)
async function mealdb(path) {
  const res = await (overrides.fetch ?? fetch)(`${MEALDB}/${path}`);
  if (!res.ok) throw new Error(`TheMealDB answered ${res.status}`);
  return (await res.json())?.meals || [];
}
const brief = (m) => ({ meal_id: m.idMeal, name: m.strMeal, image_url: m.strMealThumb || null });
function full(m) {
  const ingredients = [];
  for (let i = 1; i <= 20; i++) {
    const name = (m[`strIngredient${i}`] || '').trim();
    if (name) ingredients.push({ name, measure: (m[`strMeasure${i}`] || '').trim() });
  }
  return {
    meal_id: m.idMeal, name: m.strMeal, category: m.strCategory, cuisine: m.strArea,
    ingredients, instructions: m.strInstructions, image_url: m.strMealThumb || null, source_url: m.strSource || null,
  };
}
const MEALDB_TOOLS = [
  { name: 'search_meals', description: 'Search TheMealDB recipes by name. Returns id, name, category, cuisine and photo.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'filter_meals', description: 'List TheMealDB recipes with one main ingredient, in one category (e.g. Vegetarian, Seafood) or from one cuisine (e.g. Italian). Give exactly one of the three. Returns id, name and photo.', input_schema: { type: 'object', properties: { ingredient: { type: 'string' }, category: { type: 'string' }, cuisine: { type: 'string' } } } },
  { name: 'get_meal', description: 'The complete details of one TheMealDB recipe: ingredients with measures, instructions, category, cuisine. Look a recipe up here before saving it.', input_schema: { type: 'object', properties: { meal_id: { type: 'string' } }, required: ['meal_id'] } },
];
async function runMealDb(name, input, fetched) {
  if (name === 'search_meals') {
    const meals = await mealdb(`search.php?s=${encodeURIComponent(input.name || '')}`);
    return { meals: meals.slice(0, 15).map((m) => ({ ...brief(m), category: m.strCategory, cuisine: m.strArea })) };
  }
  if (name === 'filter_meals') {
    const [key, param] = input.ingredient ? ['ingredient', 'i'] : input.category ? ['category', 'c'] : input.cuisine ? ['cuisine', 'a'] : [];
    if (!key) return { error: 'give one of ingredient, category or cuisine' };
    const meals = await mealdb(`filter.php?${param}=${encodeURIComponent(input[key])}`);
    return { meals: meals.slice(0, 20).map(brief), total: meals.length };
  }
  if (name === 'get_meal') {
    const [m] = await mealdb(`lookup.php?i=${encodeURIComponent(input.meal_id || '')}`);
    if (!m) return { error: `no recipe has the id ${input.meal_id}` };
    fetched.add(String(m.idMeal));
    return full(m);
  }
  return null;
}

// ------------------------------------------------------------------ instructions
const FINISH = { name: 'finish', description: 'End the run with a short summary of what happened.', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } };

// Each site agent's default instructions. The instructor can edit them on the
// Admin page (stored like the step prompts, as agent "backup_scout", …, step 1).
export const SITE_PROMPTS = {
  backup_scout: `You are the Scout Agent in Meal Squad, a class system of agents that plans five dinners, Monday to Friday. You find real recipes on TheMealDB that fit a theme and save them to the coordinator, so the Pricer Agent can price them and the Meal Planner Agents can use them.
- First use the coordinator tool that explains how to work with it, and follow its formats, rules and limits.
- Search TheMealDB in different ways. Before saving a recipe, look up its complete details with get_meal and send the recipe exactly as TheMealDB has it.
- Choose four varied recipes that fit the theme, and say briefly why each fits.
- If the coordinator rejects a recipe, read all its feedback, fix the recipe and try again. If it says to wait or that a limit has been reached, stop and explain.
- Never invent recipe information.
- When four recipes have been accepted, or if you can't get four accepted, call finish with a short summary.`,
  backup_planner: `You are the Meal Planner Agent in Meal Squad, a class system of agents. You plan five dinners, Monday to Friday, from the recipes the Scout Agents found and the Pricer Agent priced, and save the plan to the coordinator.
- First use the coordinator tool that explains how to work with it, and follow its formats, checks and limits.
- Use only recipes that have a price. Every dinner must meet the dietary requirements; follow the preferences where you can.
- Aim for dinners that are varied (different cuisines and main ingredients) and as cheap as possible within the budget. Take popularity into account: the more groups picked a recipe, the more the class likes it.
- The coordinator adds up the costs; never calculate or invent a price, a recipe or a number.
- Spread similar dishes across the week: avoid the same type of food (the same cuisine, category or main ingredient) on consecutive days, and never three days in a row.
- Check a draft with the coordinator before saving it. If a check fails, change the plan and check again.
- Save the best plan once, then call finish. If no plan passes every check, save the closest one and say which checks can't be met and why. If the dietary requirements can't be met, save nothing and explain why.
- If the coordinator rejects something, fix it and try again. If it says to wait or that a limit has been reached, stop and explain.`,
  shopper: `You are the Shopper Agent in Meal Squad, a class system of agents. The Meal Planner Agents have saved meal plans of five dinners. You choose the one the class will cook and do the class's shopping: the week's Kroger cart for it. The coordinator only serves the plans and the Recipe Pricer's carts, and checks and stores what you save.
- First use the coordinator tool that explains how to work with it, and follow what it says.
- Compare every saved plan. Prefer plans that pass every check; then weigh cost (the average dinner), variety, and popularity (dinners picked by more groups are ones the class likes). Plans are priced per person.
- Build the cart for your choice, for the number of people you are given: start_cart, then buy_as_priced for the Recipe Pricer's products. Each product is checked with Kroger today.
- Then shop like a person would. The Pricer priced each recipe on its own, so the same ingredient can be bought as different products for different dinners (yellow onions in a 3 lb and a 1 lb bag, two brands of olive oil). Buy one product for all of them when they're really the same ingredient, usually the better value per unit; keep them apart when they differ (red and yellow onions, fresh and ground ginger). For each product the store no longer carries, search for a replacement: the same ingredient in a comparable size, regular rather than premium. Replace an estimated price with a real product when the store has one.
- When a line needs many packages (10 or more), look for a larger size of the same product, and buy it instead if that means fewer packages at a similar price. Kroger's stock levels are rough and can be unreliable: the cart marks lines worth checking in the store; don't treat a stock level as a promise.
- Review the cart, then save your choice once, with a short reason for the class to read: two or three plain sentences that name the group that created the plan and say why it beats the others. Mention what you combined or replaced only if it matters. Then call finish with a short summary.
- If there are no plans, or none has a cart yet, save nothing and explain why.
- Never invent a plan, a product, a price or a number.`,
};
const PROMPT_KEY = { scout: 'backup_scout', planner: 'backup_planner', shopper: 'shopper' };

async function brief_(agent, input) {
  const key = PROMPT_KEY[agent];
  const store = getStore();
  const [edited, replacedDefault] = await Promise.all([store.listPromptOverrides(key), store.listPromptDefaults(key)]);
  const system = edited.find((r) => r.step === 1)?.text || replacedDefault.find((r) => r.step === 1)?.text || SITE_PROMPTS[key];
  if (agent === 'scout') return { system, first: `The theme: ${input.theme}` };
  if (agent === 'shopper') return { system, first: `Choose the class’s meal plan. The shopping is for ${input.people} people.` };
  return {
    system,
    first: `Budget: at most $${input.budget_usd} a dinner on average, per person.\nDietary requirements: ${input.requirements || 'none'}\nPreferences: ${input.preferences || 'none'}`,
  };
}

// Same plan, same text: keys sorted, so a plan checked and then saved matches.
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v));
const cut = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}…` : s);
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

// ------------------------------------------------------------------ the run
export async function startBackupRun(raw) {
  const problem = backupProblem();
  if (problem) return { ok: false, status: 503, errors: [problem] };
  const parsed = startSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`) };
  const input = parsed.data;
  const groupName = normalizeGroup(input.group);
  if (!groupName) return { ok: false, status: 400, errors: ['group must be 1 to 40 letters, numbers, dashes or underscores'] };
  const created = await getStore().createBackupRun({ agent: input.agent, group_name: groupName, input });
  if (created.busy) return { ok: false, status: 409, errors: [`A ${{ scout: 'Scout', planner: 'Planner', shopper: 'Shopper' }[input.agent]} Agent is already running. Wait for it to finish.`] };
  const job = runAgent(created.id, input.agent, groupName, input).catch((e) => console.error('backup agent:', e));
  if (overrides.background) {
    try { waitUntil(job); } catch { /* not on Vercel: the promise just runs */ }
  } else {
    await job;
  }
  return { ok: true, id: created.id };
}

async function runAgent(id, agent, groupName, input) {
  const store = getStore();
  let actions = 0;
  const log = (s) => store.addBackupStep(id, { at: new Date().toISOString(), ...s, ...(s.text != null && { text: redact(s.text) }) }, actions);
  const end = async (status, outcome, summary) => {
    await log({ kind: status === 'done' ? 'final' : 'error', text: `${outcome}: ${summary}` });
    await store.finishBackupRun(id, { status, outcome, summary: redact(summary) });
  };
  const deadline = Date.now() + LIMITS.runMs;
  const limit = LIMITS[agent];

  try {
    const coord = coordinator(agent, groupName);
    const coordTools = await coord.tools();
    await log({ kind: 'thought', text: `Asked the coordinator for its tools: ${coordTools.map((t) => t.name).join(', ')}.` });
    const coordNames = new Set(coordTools.map((t) => t.name));
    // The Shopper shops with its own tools; start_cart reads the plan's ingredients
    // from the coordinator, and the app sends the cart it built with save_choice.
    const shopper = agent === 'shopper' ? createShopper({ people: input.people, coordCall: (name, args) => coord.call(name, args) }) : null;
    const asTool = (t) => (shopper && t.name === 'save_choice'
      ? { name: t.name, description: `${t.description} The app sends the cart you built: give plan_id and reason.`, input_schema: { type: 'object', properties: { plan_id: { type: 'string' }, reason: { type: 'string' } }, required: ['plan_id', 'reason'], additionalProperties: false } }
      : { name: t.name, description: t.description || '', input_schema: t.inputSchema || { type: 'object' } });
    const tools = [
      ...coordTools.filter((t) => !(shopper && t.name === 'get_plan_ingredients')).map(asTool),
      ...(agent === 'scout' ? MEALDB_TOOLS : []),
      ...(shopper ? SHOPPER_TOOLS : []),
      FINISH,
    ];
    const { system, first } = await brief_(agent, input);
    const messages = [{ role: 'user', content: first }];
    const model = backupModel();
    const call = (params) => (overrides.model ?? callModel)(params);

    // What the app itself enforces, as the students' prompts ask.
    const fetched = new Set(); // Scout: recipes looked up in full during this run
    let accepted = 0; // Scout: recipes the coordinator accepted
    const checked = new Set(); // Planner: plans the coordinator checked during this run
    let saved = null; // Planner: the saved plan's answer
    let chosen = null; // Shopper: the saved choice

    while (true) {
      if (Date.now() > deadline) return end('failed', 'Run failed', 'Ran out of time (4 minutes).');
      let response;
      try {
        response = await call({ model, max_tokens: 16000, system, tools, messages });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) return end('failed', 'Run failed', 'The AI service rejected ANTHROPIC_API_KEY.');
        return end('failed', 'Run failed', `The AI service returned an error: ${e.message}`);
      }
      if (response.stop_reason === 'refusal') return end('failed', 'Run failed', 'The model declined to continue.');
      for (const b of response.content) if (b.type === 'text' && b.text.trim()) await log({ kind: 'thought', text: b.text.trim() });
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason === 'max_tokens') return end('failed', 'Run failed', 'The model’s answer was too long.');

      const uses = response.content.filter((b) => b.type === 'tool_use');
      if (!uses.length) {
        messages.push({ role: 'user', content: 'Carry on, and call finish when you are done.' });
        continue;
      }
      const results = [];
      let finished = null;
      for (const use of uses) {
        actions += 1;
        await log({ kind: 'tool_call', tool: use.name, input: use.input });
        let text;
        let isError = false;
        try {
          if (use.name === 'finish') {
            finished = String(use.input?.summary || '');
            text = 'Run ended.';
          } else if (agent === 'scout' && use.name === 'save_recipe' && !fetched.has(String(use.input?.meal_id))) {
            [text, isError] = ['Not sent: look up this recipe’s complete details with get_meal first.', true];
          } else if (agent === 'planner' && use.name === 'save_meal_plan' && saved) {
            [text, isError] = ['Not sent: this run has already saved a plan.', true];
          } else if (agent === 'planner' && use.name === 'save_meal_plan' && !checked.has(canonical(use.input))) {
            [text, isError] = ['Not sent: check this exact plan with the coordinator first.', true];
          } else if (agent === 'shopper' && use.name === 'save_choice' && chosen) {
            [text, isError] = ['Not sent: this run has already saved a choice.', true];
          } else if (shopper && use.name === 'save_choice' && shopper.planId() !== String(use.input?.plan_id)) {
            [text, isError] = ['Not sent: build this plan’s cart first (start_cart).', true];
          } else if (shopper && use.name === 'save_choice' && !shopper.complete()) {
            [text, isError] = ['Not sent: some needs aren’t in the cart yet (review_cart).', true];
          } else if (shopper?.names.has(use.name)) {
            const out = await shopper.run(use.name, use.input);
            if (out?.error) [text, isError] = [out.error, true];
            else text = JSON.stringify(out);
          } else if (coordNames.has(use.name)) {
            const args = shopper && use.name === 'save_choice' ? { plan_id: use.input?.plan_id, reason: use.input?.reason, cart: shopper.cart() } : use.input;
            ({ text, isError } = await coord.call(use.name, args));
            if (!isError && use.name === 'save_recipe') accepted += 1;
            if (!isError && use.name === 'check_meal_plan') checked.add(canonical(use.input));
            if (!isError && use.name === 'save_meal_plan') saved = parse(text) ?? {};
            if (!isError && use.name === 'save_choice') chosen = parse(text) ?? {};
          } else {
            const out = await runMealDb(use.name, use.input || {}, fetched);
            if (!out) [text, isError] = [`unknown tool ${use.name}`, true];
            else if (out.error) [text, isError] = [out.error, true];
            else text = JSON.stringify(out);
          }
        } catch (e) {
          [text, isError] = [e.message, true];
        }
        await log({ kind: isError ? 'error' : 'tool_result', tool: use.name, text: cut(text, 1500) });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: cut(text, 30_000), ...(isError && { is_error: true }) });
      }
      messages.push({ role: 'user', content: results });

      if (agent === 'scout' && accepted >= 4) return end('done', 'Four recipes saved', finished || 'The coordinator accepted four recipes.');
      if (finished != null) {
        if (agent === 'scout') return end('done', `${accepted} recipe${accepted === 1 ? '' : 's'} saved`, finished);
        if (agent === 'shopper') return end('done', chosen ? 'Plan chosen' : 'No plan chosen', finished);
        if (saved?.all_rules_passed) return end('done', 'Valid plan found', finished);
        return end('done', 'No feasible plan found', finished);
      }
      if (actions >= limit) return end('failed', 'Run failed', `Reached the limit of ${limit} actions before finishing.`);
    }
  } catch (e) {
    return end('failed', 'Run failed', e.message);
  }
}

export async function getBackupRun(id) {
  if (!z.uuid().safeParse(id).success) return null;
  return getStore().getBackupRun(id);
}
export const listBackupRuns = () => getStore().listBackupRuns(20);
