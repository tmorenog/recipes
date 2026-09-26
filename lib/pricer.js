// The Recipe Pricer: an agent of its own, already built. It is deployed with
// the coordinator's site, but reads recipes and saves prices like any agent.
// For each recipe the Scout Agents save, it finds every ingredient at the class's
// Kroger store and builds the shopping cart and its cost. (Nutrition is the Meal Planner's job.) The AI
// chooses products and amounts; code does the arithmetic.
//
// Each TheMealDB recipe is priced once for the whole class (pricings.meal_id).
// A save puts it in the queue and starts a run in the background; the Pricer
// and Coordinator pages restart runs that stopped. Every step is saved, so the
// Pricer page can show the basket filling up and what the agent is doing.
import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { getStore } from './store/index.js';
import { setting } from './env.js';
import { findStores, searchProducts, krogerConfigured } from './kroger.js';
import { priceShare } from './units.js';
import { redact } from './secrets.js';
import { logExchange } from './exchanges.js';
import { getSettings } from './settings.js';

// ANTHROPIC_API_KEY should be just the key. If the setting holds more (a
// pasted example command, a label, quotes), the one key inside it is used.
export function readAiKey(raw) {
  const value = raw?.trim().replace(/^(["'])(.*)\1$/, '$2').trim() || null;
  if (!value || aiKeyLooksRight(value)) return { key: value, extracted: false };
  const found = value.match(/sk-ant-[A-Za-z0-9_-]{20,}/g) || [];
  return found.length === 1 ? { key: found[0], extracted: true } : { key: value, extracted: false };
}

// What's wrong with the setting, without showing any of it.
export function describeAiKey(raw) {
  const v = String(raw ?? '');
  const keys = (v.match(/sk-ant-/g) || []).length;
  return [
    `${v.length} characters`,
    v.trim().startsWith('sk-ant-') ? 'starts with sk-ant-' : 'doesn’t start with sk-ant-',
    /\s/.test(v.trim()) ? 'has spaces inside' : null,
    /[\r\n]/.test(v.trim()) ? 'has line breaks' : null,
    keys === 0 ? 'no sk-ant- key anywhere in it' : keys > 1 ? `${keys} keys in it` : null,
  ].filter(Boolean).join(', ');
}

export const pricerSettings = (env = process.env) => ({
  aiKey: readAiKey(setting(['ANTHROPIC_API_KEY'], env)).key,
  aiKeyExtracted: readAiKey(setting(['ANTHROPIC_API_KEY'], env)).extracted,
  model: setting(['PRICER_MODEL'], env) || 'claude-haiku-4-5', // the cheapest current model; plenty for matching products
  zip: setting(['PRICER_ZIP'], env) || '45202',
});

export const LIMITS = {
  toolCalls: 60, // per recipe
  runMs: 200_000, // per background run; a longer pricing carries on in the next run
  maxActive: 2, // recipes priced at the same time
  nudges: 2, // times the model may stop without calling finish
};

// Tests swap in a scripted model and fake Kroger answers.
const overrides = { model: null, fetch: null, auto: true };
export function setPricerForTests(o) {
  Object.assign(overrides, o);
}

// An Anthropic API key is one word starting sk-ant-. A common mistake is
// pasting a whole example command; never send that anywhere.
export const aiKeyLooksRight = (key) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);
export const AI_KEY_WRONG =
  'ANTHROPIC_API_KEY doesn’t look like an API key: in Vercel it must be only the key, one line starting “sk-ant-”, with no command, quotes or spaces. Fix it, then redeploy (Deployments → ⋯ → Redeploy): Vercel only reads settings when it deploys.';
export const AI_KEY_EXTRACTED =
  'ANTHROPIC_API_KEY holds more than the key, so the coordinator is using the sk-ant- key inside it. Tidy it up in Vercel when you can: the value should be only the key.';

// Why the Pricer can't run yet, or null when it can.
export function pricerProblem() {
  if (!overrides.model) {
    const key = pricerSettings().aiKey;
    if (!key) return 'The Pricer Agent needs an AI key: the instructor should add ANTHROPIC_API_KEY in Vercel.';
    if (!aiKeyLooksRight(key)) return `${AI_KEY_WRONG} What the coordinator sees: ${describeAiKey(setting(['ANTHROPIC_API_KEY']))}.`;
  }
  if (!krogerConfigured()) return 'The Pricer Agent needs Kroger: the instructor should add KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in Vercel.';
  return null;
}

// ------------------------------------------------------------------ the model
// The instructions the agent follows. The instructor can change them on the
// Pricer page (stored in pricer_config); this is the starting point.
export const DEFAULT_PROMPT = `You are the Recipe Pricer, one of the agents in the class's Meal Squad system. For each recipe, find what one serving costs (one person's dinner) when the class buys its ingredients at Kroger, so the Meal Planners can compare recipes by price per person. You only price.

The recipe will be cooked for a large number of people, so price it at scale: build the cart for 50 people, scaling the recipe's quantities from the number of people it serves to 50. At that scale each serving pays only for the share of each package it uses, so the cost per serving is the cart's cost divided by 50. Later, the Shopper Agent scales the chosen meal plan to the number of people actually shopping for.

Product data comes from Kroger's Products API, searched at one store. Its documentation: https://developer.kroger.com/documentation/public/product/overview
Your tools are described in their own definitions: work out from them which to use and when. They also do the arithmetic, so leave package counts and costs to them.

A good cart:
- accounts for every ingredient line: priced from Kroger where possible; when the store doesn't have the item itself, priced with a close substitute from Kroger (recorded as a substitute, saying what it replaces, e.g. Swiss cheese for gruyère); estimated, with the reason, only when Kroger has nothing suitable, not even a substitute; skipped when nothing is bought (water, "salt, to taste");
- uses products that match what the recipe means (fresh garlic, not garlic powder), in package sizes that suit the amount, regular rather than premium;
- never presents an invented product or price as Kroger's.

You run on a small, low-cost model, so work efficiently: a search or two per ingredient, brief reasoning, no repeated calls.

When the cart is complete, finish with the number of people it feeds and a short summary of anything uncertain.`;

// The default is DEFAULT_PROMPT unless the instructor replaced it (Admin page).
export async function defaultPrompt() {
  return (await getStore().listPromptDefaults('pricer')).find((r) => r.step === 1)?.text || DEFAULT_PROMPT;
}
export async function currentPrompt() {
  return (await getStore().getPricerConfig('prompt')) || defaultPrompt();
}

const TOOLS = [
  {
    name: 'search_kroger',
    description: 'Search the class Kroger store. Returns up to 5 products with product_id, description, size and price_usd (promo_price_usd when on sale).',
    input_schema: {
      type: 'object',
      properties: { term: { type: 'string', description: 'What to search for, e.g. "yellow onions" or "canned chickpeas"' } },
      required: ['term'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_ingredient',
    description:
      'Record how one ingredient line is bought. Code works out the share of the package used, its cost and how many packages to buy.',
    input_schema: {
      type: 'object',
      properties: {
        line: { type: 'integer', description: 'The ingredient line number' },
        kroger_product_id: { type: 'string', description: 'A product_id from search_kroger' },
        amount_used: { type: 'number', description: 'How much of the product the recipe uses, e.g. 2' },
        unit_used: { type: 'string', description: 'Unit of amount_used: g, kg, oz, lb, ml, l, tsp, tbsp, cup, fl oz or each' },
        grams: { type: ['number', 'null'], description: 'Only when converting between volume and weight (or a count and weight): your estimate of the weight used, in grams' },
        note: { type: 'string', description: 'Optional: anything uncertain about this choice' },
        substitute_for: { type: 'string', description: 'Only when this product is a substitute because the store doesn’t have what the recipe calls for: what it replaces and why, e.g. "gruyère: none at this store"' },
      },
      required: ['line', 'kroger_product_id', 'amount_used', 'unit_used'],
      additionalProperties: false,
    },
  },
  {
    name: 'estimate_ingredient',
    description:
      'Use only when Kroger has no suitable product or no price for a line: record an estimated price instead. ' +
      'Code works out the share of the package used, its cost and how many packages to buy; the line is labelled as estimated.',
    input_schema: {
      type: 'object',
      properties: {
        line: { type: 'integer', description: 'The ingredient line number' },
        item: { type: 'string', description: 'What would be bought, e.g. "fresh fennel bulb"' },
        package_size: { type: 'string', description: 'A typical package, e.g. "1 lb", "16 fl oz", "each"' },
        package_price_usd: { type: 'number', description: 'Your estimate of that package’s price at a US supermarket' },
        amount_used: { type: 'number', description: 'How much of it the recipe uses, e.g. 2' },
        unit_used: { type: 'string', description: 'Unit of amount_used: g, kg, oz, lb, ml, l, tsp, tbsp, cup, fl oz or each' },
        grams: { type: ['number', 'null'], description: 'Only when converting between volume and weight: the weight used, in grams' },
        reason: { type: 'string', description: 'Why Kroger’s price couldn’t be used, e.g. "no fennel at this store"' },
      },
      required: ['line', 'item', 'package_size', 'package_price_usd', 'amount_used', 'unit_used', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'skip_ingredient',
    description: 'Mark a line that is not bought, e.g. water, or salt "to taste" with no amount. It costs nothing.',
    input_schema: {
      type: 'object',
      properties: {
        line: { type: 'integer', description: 'The ingredient line number' },
        reason: { type: 'string', description: 'Why it is not bought' },
      },
      required: ['line', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'Call when every ingredient line is recorded or skipped.',
    input_schema: {
      type: 'object',
      properties: {
        people: { type: 'integer', description: 'How many people the cart feeds, as your instructions say' },
        summary: { type: 'string', description: 'Two sentences: what the cart costs and anything uncertain' },
      },
      required: ['people', 'summary'],
      additionalProperties: false,
    },
  },
];

// Server-side refusal fallbacks, for the models that support them.
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);
let client;
export async function callModel(params) {
  if (overrides.model) return overrides.model(params);
  client ??= new Anthropic({ apiKey: pricerSettings().aiKey });
  if (FALLBACK_MODELS.has(params.model)) {
    return client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  }
  return client.messages.create(params);
}

// ------------------------------------------------------------------ the tools
const fetchImpl = () => overrides.fetch ?? fetch;

async function cached(key, maxAgeSeconds, load) {
  const store = getStore();
  const hit = await store.cacheGet(key, maxAgeSeconds);
  if (hit) return hit;
  const data = await load();
  await store.cacheSet(key, data);
  return data;
}

export const krogerFetch = fetchImpl;
export async function classStore() {
  const { zip } = pricerSettings();
  return cached(`kroger-store:${zip}`, 7 * 24 * 3600, async () => {
    const res = await findStores({ zip }, fetchImpl());
    if (!res.ok) throw new Error(res.errors.join('; '));
    if (!res.stores.length) throw new Error(`Kroger has no store near ZIP ${zip}. Set PRICER_ZIP to another ZIP code in Vercel.`);
    return res.stores[0];
  });
}

const lineSchema = (n) => z.number().int().min(1).max(n);
const round2 = (x) => Math.round(x * 100) / 100;
async function runTool(name, input, ctx) {
  const lines = ctx.recipe.ingredients;
  const remaining = () => lines.map((_, i) => i + 1).filter((n) => !ctx.basket[n - 1]);
  switch (name) {
    case 'search_kroger': {
      const term = String(input?.term ?? '').trim();
      if (term.length < 2) return { error: 'term is too short' };
      const res = await cached(`kroger:${ctx.store.store_id}:${term.toLowerCase()}`, 6 * 3600, async () => {
        const r = await searchProducts({ term, store_id: ctx.store.store_id, limit: 5 }, fetchImpl());
        if (!r.ok) throw new Error(r.errors.join('; '));
        return r.products;
      });
      for (const p of res) ctx.seen.products[p.product_id] = p;
      const products = res.map(({ image_url, ...p }) => p);
      return { result: { count: products.length, products, hint: products.length ? undefined : 'Nothing found: try a simpler term.' } };
    }
    case 'record_ingredient': {
      const parsed = z
        .object({
          line: lineSchema(lines.length),
          kroger_product_id: z.string(),
          amount_used: z.number().positive(),
          unit_used: z.string(),
          grams: z.number().positive().nullish(),
          note: z.string().optional(),
          substitute_for: z.string().trim().max(300).optional(),
        })
        .safeParse(input);
      if (!parsed.success) return { error: `check the input: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
      const d = parsed.data;
      const product = ctx.seen.products[d.kroger_product_id];
      if (!product) return { error: `product ${d.kroger_product_id} wasn't in your search_kroger results; search first and use a product_id from them` };
      const price = product.promo_price_usd ?? product.price_usd;
      if (price == null) return { error: 'that product has no price at this store; choose another' };
      const share = priceShare({ amount: d.amount_used, unitName: d.unit_used, grams: d.grams, size: product.size, price });
      if (share.error) return { error: share.error };
      const ing = lines[d.line - 1];
      ctx.basket[d.line - 1] = {
        line: d.line,
        ingredient: ing.name,
        raw: ing.raw ?? null,
        status: 'bought',
        product: { id: product.product_id, description: product.description, brand: product.brand, size: product.size, price_usd: price, on_sale: product.promo_price_usd != null, image_url: product.image_url ?? null },
        amount_used: d.amount_used,
        unit_used: d.unit_used,
        grams: d.grams ?? null,
        fraction: share.fraction,
        packages: share.packages,
        cost_used_usd: share.cost_used_usd,
        cost_to_buy_usd: share.cost_to_buy_usd,
        note: [share.note, d.note].filter(Boolean).join('; ') || null,
        substitute_for: d.substitute_for || null,
      };
      const e = ctx.basket[d.line - 1];
      return { result: { recorded: d.line, substitute: e.substitute_for ? 'labelled as a substitute' : undefined, cost_used_usd: e.cost_used_usd, packages_to_buy: e.packages, cost_to_buy_usd: e.cost_to_buy_usd, note: e.note, remaining_lines: remaining() } };
    }
    case 'estimate_ingredient': {
      const parsed = z
        .object({
          line: lineSchema(lines.length),
          item: z.string().trim().min(2).max(200),
          package_size: z.string().trim().min(1).max(60),
          package_price_usd: z.number().positive().max(500),
          amount_used: z.number().positive(),
          unit_used: z.string(),
          grams: z.number().positive().nullish(),
          reason: z.string().trim().min(3).max(300),
        })
        .safeParse(input);
      if (!parsed.success) return { error: `check the input: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
      const d = parsed.data;
      const share = priceShare({ amount: d.amount_used, unitName: d.unit_used, grams: d.grams, size: d.package_size, price: d.package_price_usd });
      if (share.error) return { error: share.error };
      const ing = lines[d.line - 1];
      ctx.basket[d.line - 1] = {
        line: d.line,
        ingredient: ing.name,
        raw: ing.raw ?? null,
        status: 'estimated',
        product: { id: `estimate-${d.line}`, description: d.item, brand: null, size: d.package_size, price_usd: d.package_price_usd, on_sale: false, image_url: null, estimated: true },
        amount_used: d.amount_used,
        unit_used: d.unit_used,
        grams: d.grams ?? null,
        fraction: share.fraction,
        packages: share.packages,
        cost_used_usd: share.cost_used_usd,
        cost_to_buy_usd: share.cost_to_buy_usd,
        reason: d.reason,
        note: share.note,
      };
      const e = ctx.basket[d.line - 1];
      return { result: { estimated: d.line, cost_used_usd: e.cost_used_usd, packages_to_buy: e.packages, cost_to_buy_usd: e.cost_to_buy_usd, note: 'Labelled as an estimate.', remaining_lines: remaining() } };
    }
    case 'skip_ingredient': {
      const parsed = z
        .object({ line: lineSchema(lines.length), reason: z.string().min(1) })
        .safeParse(input);
      if (!parsed.success) return { error: `check the input: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
      const d = parsed.data;
      const ing = lines[d.line - 1];
      ctx.basket[d.line - 1] = {
        line: d.line,
        ingredient: ing.name,
        raw: ing.raw ?? null,
        status: 'skipped',
        reason: d.reason,
        cost_used_usd: 0,
      };
      return { result: { skipped: d.line, remaining_lines: remaining() } };
    }
    case 'finish': {
      const missing = remaining();
      if (missing.length) return { error: `lines ${missing.join(', ')} aren't recorded or skipped yet` };
      const people = Number(input?.people);
      if (!Number.isInteger(people) || people < 1 || people > 10000) return { error: 'people must be a whole number: how many people the cart feeds' };
      return { result: { done: true }, finish: { summary: String(input?.summary ?? '').slice(0, 1000) || 'Priced.', people } };
    }
    default:
      return { error: `there is no tool called ${name}` };
  }
}

// Whole-recipe totals, computed from the basket. Packages are counted per
// product, so two lines using the same bag of onions buy it once.
export function totals(basket) {
  const bought = basket.filter((e) => e?.status === 'bought' || e?.status === 'estimated');
  const total = round2(bought.reduce((s, e) => s + e.cost_used_usd, 0));
  const byProduct = new Map();
  for (const e of bought) {
    const p = byProduct.get(e.product.id) ?? { fraction: 0, price: e.product.price_usd };
    p.fraction += e.fraction;
    byProduct.set(e.product.id, p);
  }
  const toBuy = round2([...byProduct.values()].reduce((s, p) => s + Math.max(1, Math.ceil(p.fraction - 1e-9)) * p.price, 0));
  return { total, toBuy, estimated: basket.filter((e) => e?.status === 'estimated').length };
}

// ------------------------------------------------------------------ one recipe
function firstMessage(recipe, store) {
  const lines = recipe.ingredients.map((i, n) => `${n + 1}. ${i.listed ? i.name : `${i.name}: ${i.raw || 'no amount given'}`}`).join('\n');
  return `Price this recipe at ${store.name} (${store.address}), store_id ${store.store_id}.

Recipe: ${recipe.name}
Serves about ${recipe.est_servings ?? 'an unknown number of'} people.
Ingredient lines:
${lines}`;
}

const step = (claimed, s) => getStore().addPricerStep({ meal_id: claimed.meal_id, attempt: claimed.attempts, ...s });

// The agent itself: model, tools, loop. Used for recipes in the queue and for
// the instructor's test runs. Reports through callbacks:
//   log(step)        every thought, tool call, result and error, as it happens
//   save(state)      after each turn, so a stopped run can carry on (recipes only)
// Returns { outcome: 'priced', basket, totals, summary, people }
//      or { outcome: 'failed', error, basket }
//      or { outcome: 'paused', basket }   (out of time or the AI service was busy; carry on later)
async function agentLoop({ recipe, shop, prompt, saved = null, toolCallsSoFar = 0, deadline, log: rawLog, save = async () => {} }) {
  const log = (s) => rawLog({ ...s, ...(s.text != null && { text: redact(s.text) }) });
  const { model } = pricerSettings();
  const ctx = {
    recipe,
    store: shop,
    basket: Array.from({ length: recipe.ingredients.length }, (_, i) => (saved?.basket || []).find((e) => e?.line === i + 1) ?? null),
    seen: saved?.seen ?? { products: {} },
  };
  const messages = saved?.messages ?? [{ role: 'user', content: firstMessage(recipe, shop) }];
  let nudges = saved?.nudges ?? 0;
  let toolCalls = toolCallsSoFar;
  const basket = () => ctx.basket.filter(Boolean);
  const checkpoint = () => save({ messages, seen: ctx.seen, nudges, prompt, basket: basket(), toolCalls });
  const fail = async (message) => {
    const error = redact(message);
    await log({ kind: 'error', text: error });
    return { outcome: 'failed', error, basket: basket(), toolCalls };
  };

  while (true) {
    if (Date.now() > deadline) {
      await checkpoint();
      return { outcome: 'paused', basket: basket(), toolCalls };
    }
    let response;
    try {
      response = await callModel({ model, max_tokens: 16000, system: prompt, tools: TOOLS, messages });
    } catch (e) {
      const retry = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError;
      if (retry) {
        await log({ kind: 'error', text: `The AI service is busy (${e.message}); trying again shortly.` });
        await checkpoint();
        return { outcome: 'paused', basket: basket(), toolCalls };
      }
      if (e instanceof Anthropic.AuthenticationError) return fail('The AI service rejected ANTHROPIC_API_KEY: the instructor should check it in Vercel.');
      return fail(`The AI service returned an error: ${e.message}`);
    }

    if (response.stop_reason === 'refusal') return fail('The model declined to price this recipe.');
    for (const b of response.content) if (b.type === 'text' && b.text.trim()) await log({ kind: 'thought', text: b.text.trim() });
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'max_tokens') return fail('The model’s answer was too long.');

    const uses = response.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      nudges += 1;
      if (nudges > LIMITS.nudges) return fail('The model stopped without finishing the basket.');
      messages.push({ role: 'user', content: 'Carry on: record or skip every remaining line, then call finish.' });
      await checkpoint();
      continue;
    }

    const results = [];
    let finished = null;
    for (const use of uses) {
      toolCalls += 1;
      await log({ kind: 'tool_call', tool: use.name, input: use.input });
      let out;
      try {
        out = await runTool(use.name, use.input, ctx);
      } catch (e) {
        out = { error: e.message };
      }
      if (out.error) await log({ kind: 'error', tool: use.name, text: out.error });
      else await log({ kind: 'tool_result', tool: use.name, output: out.result });
      if (out.finish) finished = out.finish;
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out.error ? { error: out.error } : out.result), ...(out.error && { is_error: true }) });
    }
    messages.push({ role: 'user', content: results });

    if (finished) {
      const t = totals(basket());
      await log({ kind: 'final', text: finished.summary, output: { people: finished.people, cart_usd: t.toBuy, cost_used_usd: t.total, estimated_lines: t.estimated } });
      return { outcome: 'priced', basket: basket(), totals: t, summary: finished.summary, people: finished.people, toolCalls };
    }
    if (toolCalls >= LIMITS.toolCalls) return fail(`Reached the limit of ${LIMITS.toolCalls} tool calls before finishing.`);
    await checkpoint();
  }
}

// A run whose recipe was reset or taken over by another run stops quietly.
class ClaimLost extends Error {}

// One recipe from the queue. Every write carries the run's claim token.
async function priceOne(claimed, deadline) {
  const store = getStore();
  const { model } = pricerSettings();
  const recipe = claimed.recipe;
  const token = claimed.claim_token;
  if (!recipe) return store.finishPricing(claimed.meal_id, { status: 'failed', error: 'the recipe was deleted', token });
  const log = (s) => step(claimed, s);

  let shop;
  try {
    shop = await classStore();
  } catch (e) {
    await log({ kind: 'error', text: redact(e.message) });
    return store.finishPricing(claimed.meal_id, { status: 'failed', error: redact(e.message), token });
  }

  // Carry on from where an earlier run stopped, or start fresh. A run keeps the prompt it started with.
  const saved = claimed.messages ? { ...claimed.messages, basket: claimed.basket } : null;
  const prompt = saved?.prompt ?? (await currentPrompt());
  if (!saved) await log({ kind: 'thought', text: `Pricing ${recipe.name} at ${shop.name} (store ${shop.store_id}) with ${model}.` });

  let result;
  try {
    result = await agentLoop({
      recipe,
      shop,
      prompt,
      saved,
      toolCallsSoFar: claimed.tool_calls ?? 0,
      deadline,
      log,
      save: async (st) => {
        const kept = await store.savePricingProgress(claimed.meal_id, {
          messages: { messages: st.messages, seen: st.seen, nudges: st.nudges, prompt: st.prompt },
          basket: st.basket,
          toolCalls: st.toolCalls,
          storeId: shop.store_id,
          token,
        });
        if (!kept) throw new ClaimLost();
      },
    });
  } catch (e) {
    if (e instanceof ClaimLost) return null;
    throw e;
  }
  if (result.outcome === 'paused') {
    await store.releasePricing(claimed.meal_id, token); // the next run carries on
    return 'paused';
  }
  if (result.outcome === 'failed') {
    if (!(await store.finishPricing(claimed.meal_id, { status: 'failed', error: result.error, basket: result.basket, token }))) return null;
    return logPricing(recipe, claimed, { ok: false, summary: `couldn’t price it: ${result.error}` });
  }
  const t = result.totals;
  const kept = await store.finishPricing(claimed.meal_id, {
    status: 'priced', summary: result.summary, people: result.people, prompt, basket: result.basket, total: t.total, toBuy: t.toBuy, token,
  });
  if (!kept) return null; // reset while it was being priced: the new run's price counts
  const per = result.people ? t.total / result.people : null;
  return logPricing(recipe, claimed, {
    ok: true,
    summary: `saved the price: ${per == null ? '?' : `$${per.toFixed(2)}`} a serving, cart $${t.toBuy.toFixed(2)} for ${result.people} people${t.estimated ? `, ${t.estimated} estimated` : ''}`,
    response: { people: result.people, cost_used_usd: t.total, cart_usd: t.toBuy, estimated_lines: t.estimated, summary: result.summary },
  });
}

// The Pricer's result, on the Coordinator page next to the agents' requests.
const logPricing = (recipe, claimed, { ok, summary, response = null }) => logExchange({
  agent: 'pricer', group_name: null, method: 'pricer', tool: 'price_recipe', ok,
  request: { meal_id: claimed.meal_id, name: recipe.name }, request_summary: recipe.name,
  response, summary,
});

// ------------------------------------------------------------------ test runs
// The instructor tries the agent on a short ingredient list, with the saved
// prompt or a draft. Real model and real Kroger prices; nothing is saved to
// the recipes. Each run and its steps are kept in pricer_tests for the page.
export const SAMPLE_RECIPE = 'Chicken and chickpea stew';
export const SAMPLE_INGREDIENTS = ['1 lb boneless chicken thighs', '1 yellow onion', '3 cloves garlic', '1 can (15 oz) chickpeas', 'salt, to taste'];

export const testSchema = z.strictObject({
  name: z.string().trim().min(2).max(120).default(SAMPLE_RECIPE),
  ingredients: z.array(z.string().trim().min(2).max(200)).min(1).max(12),
  serves: z.number().int().min(1).max(100).default(4),
  prompt: z.string().trim().min(50).max(20000).optional(),
});

export const TEST_LIMITS = { perHour: 30 };

export async function startTest(input) {
  const problem = pricerProblem();
  if (problem) return { ok: false, status: 503, errors: [problem] };
  // Anyone may run a test, so keep it to one at a time and a few an hour.
  const recent = await getStore().recentPricerTests(60);
  if (recent.running > 0) return { ok: false, status: 429, errors: ['A test is already running. Watch it below, then try again.'] };
  if (recent.n >= TEST_LIMITS.perHour) return { ok: false, status: 429, errors: [`That’s ${TEST_LIMITS.perHour} tests in the last hour: try again later.`] };
  const parsed = testSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`) };
  const { name, ingredients, serves } = parsed.data;
  const prompt = parsed.data.prompt || (await currentPrompt());
  const store = getStore();
  const test = await store.createPricerTest({ name, ingredients, serves, prompt, draft: Boolean(parsed.data.prompt) && parsed.data.prompt !== (await currentPrompt()) });
  const run = runTest(test.id, { name, ingredients, serves, prompt }).catch(async (e) => {
    console.error('Pricer test:', e);
    await store.updatePricerTest(test.id, { status: 'failed', error: redact(e.message) });
  });
  try {
    waitUntil(run);
  } catch {
    /* not on Vercel */
  }
  return { ok: true, id: test.id, run };
}

async function runTest(id, { name, ingredients, serves, prompt }) {
  const store = getStore();
  const log = (s) => store.addPricerTestStep(id, { ...s, at: new Date().toISOString() });
  let shop;
  try {
    shop = await classStore();
  } catch (e) {
    await log({ kind: 'error', text: redact(e.message) });
    return store.updatePricerTest(id, { status: 'failed', error: redact(e.message) });
  }
  const recipe = { name, est_servings: serves, ingredients: ingredients.map((line) => ({ name: line, raw: null, listed: true })) };
  await log({ kind: 'thought', text: `Test run: pricing ${name} (${ingredients.length} ingredients) at ${shop.name} (store ${shop.store_id}) with ${pricerSettings().model}.` });
  const result = await agentLoop({
    recipe,
    shop,
    prompt,
    deadline: Date.now() + LIMITS.runMs,
    log,
    save: (st) => store.updatePricerTest(id, { basket: st.basket, tool_calls: st.toolCalls }),
  });
  if (result.outcome === 'priced') {
    return store.updatePricerTest(id, {
      status: 'done', basket: result.basket, summary: result.summary, people: result.people, tool_calls: result.toolCalls,
      totals: { cart_usd: result.totals.toBuy, cost_used_usd: result.totals.total, estimated_lines: result.totals.estimated },
    });
  }
  const error = result.outcome === 'paused' ? 'The test ran out of time or the AI service was busy. Try again, perhaps with fewer ingredients.' : result.error;
  return store.updatePricerTest(id, { status: 'failed', error, basket: result.basket, tool_calls: result.toolCalls });
}

// ------------------------------------------------------------------ the queue
// Prices waiting recipes one after another until none are left or time runs out.
export async function runQueue({ budgetMs = LIMITS.runMs } = {}) {
  if (pricerProblem()) return 0;
  const deadline = Date.now() + budgetMs;
  let done = 0;
  const { max_priced_per_hour: perHour } = await getSettings();
  while (Date.now() < deadline) {
    // The instructor's hourly limit: the rest waits in the queue.
    if (perHour > 0 && (await getStore().pricingsFinishedSince(new Date(Date.now() - 3_600_000).toISOString())) >= perHour) break;
    const claimed = await getStore().claimPricing({ maxActive: LIMITS.maxActive });
    if (!claimed) break;
    // Paused (out of time, or the AI service is busy): stop, rather than retry at once.
    if ((await priceOne(claimed, deadline)) === 'paused') break;
    done += 1;
  }
  return done;
}

// Starts a background run after the response is sent (Vercel keeps the
// function alive for it). Returns the run's promise, for tests.
export function kickPricer() {
  if (!overrides.auto || pricerProblem()) return null;
  const run = runQueue().catch((e) => console.error('Pricer:', e));
  try {
    waitUntil(run);
  } catch {
    /* not on Vercel: the promise just runs */
  }
  return run;
}

// Called when someone looks at the Pricer or Coordinator page: starts a run if
// recipes are waiting, or a run stopped part-way. At most every 10 s per instance.
let lastCheck = 0;
export async function resumePricer() {
  if (!overrides.auto || pricerProblem() || Date.now() - lastCheck < 10_000) return;
  lastCheck = Date.now();
  const work = await getStore().pricingWork();
  if (work.pending > 0 || work.stale > 0) kickPricer();
}

export const pricerInfo = () => {
  const { model, zip } = pricerSettings();
  return { model, zip, problem: pricerProblem(), limits: { tool_calls: LIMITS.toolCalls, seconds_per_run: LIMITS.runMs / 1000 } };
};

export { TOOLS as PRICER_TOOLS };
