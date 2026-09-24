// The Pricer: an agent that runs on the coordinator. For each recipe the Scouts
// save, it finds every ingredient at the class's Kroger store and in USDA
// FoodData Central, and records what the recipe costs and what it adds
// nutritionally. The AI chooses products and amounts; code does the arithmetic.
//
// Each TheMealDB recipe is priced once for the whole class (pricings.meal_id).
// A save puts it in the queue and starts a run in the background; the Pricer
// and Database pages restart runs that stopped. Every step is saved, so the
// Pricer page can show the basket filling up and what the agent is doing.
import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { getStore } from './store/index.js';
import { setting } from './env.js';
import { findStores, searchProducts, krogerConfigured } from './kroger.js';
import { searchFoods } from './usda.js';
import { priceShare } from './units.js';

export const pricerSettings = (env = process.env) => ({
  aiKey: setting(['ANTHROPIC_API_KEY'], env),
  model: setting(['PRICER_MODEL'], env) || 'claude-opus-5',
  zip: setting(['PRICER_ZIP'], env) || '45202',
});

export const LIMITS = {
  toolCalls: 60, // per recipe
  runMs: 200_000, // per background run; a longer pricing carries on in the next run
  maxActive: 2, // recipes priced at the same time
  nudges: 2, // times the model may stop without calling finish
};

// Tests swap in a scripted model and fake Kroger/USDA answers.
const overrides = { model: null, fetch: null, auto: true };
export function setPricerForTests(o) {
  Object.assign(overrides, o);
}

// Why the Pricer can't run yet, or null when it can.
export function pricerProblem() {
  if (!overrides.model && !pricerSettings().aiKey) return 'The Pricer needs an AI key: the instructor should add ANTHROPIC_API_KEY in Vercel.';
  if (!krogerConfigured()) return 'The Pricer needs Kroger: the instructor should add KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in Vercel.';
  return null;
}

// ------------------------------------------------------------------ the model
// The instructions the agent follows. The instructor can change them on the
// Pricer page (stored in pricer_config); this is the starting point.
export const DEFAULT_PROMPT = `You are the Pricer, an agent that runs on the class's recipe coordinator. For one recipe, you build the Kroger shopping cart needed to cook it and work out what it adds nutritionally, so the Meal Planner agents can compare recipes fairly.

We are buying for 50 people. Scale every quantity from the number of people the recipe serves to 50 people: a recipe that serves 4 needs 12.5 times each amount.

For every numbered ingredient line, call record_ingredient or skip_ingredient:
1. search_kroger for the ingredient in the form the recipe uses: fresh garlic, not garlic powder; canned chickpeas when the recipe uses a can. Choose a product that matches and a package size that suits the amount: for large amounts, bigger packages are usually cheaper. Prefer regular products over organic or premium ones unless nothing else matches. If nothing matches, try a simpler or more general term.
2. Decide how much of that product the scaled recipe uses, as amount_used and unit_used (g, kg, oz, lb, ml, l, tsp, tbsp, cup, fl oz or each), and estimate its weight in grams.
3. search_usda for the plain food, e.g. "onion raw" or "chickpeas canned", and pick the closest entry.
4. Call record_ingredient with the product_id, the amounts and the USDA fdc_id. Code works out how many packages to buy, the cost and the nutrition: never calculate them yourself.

Skip a line only when nothing is bought: water, or an ingredient with no amount such as "salt, to taste". When a skipped line still adds nutrition (1 tsp salt adds sodium), give grams and usda_fdc_id.
If a tool returns an error, fix what it says and try again. Never invent a product, price or nutrient: use only what the searches return.
When every line is recorded or skipped, call finish with the number of people the cart feeds and a two-sentence summary that mentions anything uncertain.`;

export async function currentPrompt() {
  return (await getStore().getPricerConfig('prompt')) || DEFAULT_PROMPT;
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
    name: 'search_usda',
    description: 'Search USDA FoodData Central for a generic food. Returns up to 5 foods with fdc_id, description and nutrients per 100 g.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A plain food, e.g. "onion raw" or "chickpeas canned drained"' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_ingredient',
    description:
      'Record how one ingredient line is bought. Code works out the share of the package used, its cost, how many packages to buy, and the nutrition.',
    input_schema: {
      type: 'object',
      properties: {
        line: { type: 'integer', description: 'The ingredient line number' },
        kroger_product_id: { type: 'string', description: 'A product_id from search_kroger' },
        amount_used: { type: 'number', description: 'How much of the product the recipe uses, e.g. 2' },
        unit_used: { type: 'string', description: 'Unit of amount_used: g, kg, oz, lb, ml, l, tsp, tbsp, cup, fl oz or each' },
        grams: { type: 'number', description: 'Your estimate of the weight used, in grams' },
        usda_fdc_id: { type: ['integer', 'null'], description: 'An fdc_id from search_usda, or null if none fits' },
        note: { type: 'string', description: 'Optional: anything uncertain about this choice' },
      },
      required: ['line', 'kroger_product_id', 'amount_used', 'unit_used', 'grams', 'usda_fdc_id'],
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
        grams: { type: ['number', 'null'], description: 'Weight used, if it still adds nutrition' },
        usda_fdc_id: { type: ['integer', 'null'], description: 'An fdc_id from search_usda, if it still adds nutrition' },
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
async function callModel(params) {
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

async function classStore() {
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
const NUTRIENTS = ['calories', 'protein_g', 'fiber_g', 'sodium_mg'];

function nutritionFor(food, grams) {
  if (!food || !(grams > 0)) return null;
  return Object.fromEntries(NUTRIENTS.map((k) => [k, food.per_100g[k] == null ? null : round2((food.per_100g[k] * grams) / 100)]));
}

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
    case 'search_usda': {
      const query = String(input?.query ?? '').trim();
      if (query.length < 2) return { error: 'query is too short' };
      const foods = await cached(`usda:${query.toLowerCase()}`, 30 * 24 * 3600, () => searchFoods(query, { fetchImpl: fetchImpl() }));
      for (const f of foods) ctx.seen.foods[f.fdc_id] = f;
      return { result: { count: foods.length, foods, hint: foods.length ? undefined : 'Nothing found: try a plainer name.' } };
    }
    case 'record_ingredient': {
      const parsed = z
        .object({
          line: lineSchema(lines.length),
          kroger_product_id: z.string(),
          amount_used: z.number().positive(),
          unit_used: z.string(),
          grams: z.number().positive(),
          usda_fdc_id: z.number().int().nullable(),
          note: z.string().optional(),
        })
        .safeParse(input);
      if (!parsed.success) return { error: `check the input: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
      const d = parsed.data;
      const product = ctx.seen.products[d.kroger_product_id];
      if (!product) return { error: `product ${d.kroger_product_id} wasn't in your search_kroger results; search first and use a product_id from them` };
      const price = product.promo_price_usd ?? product.price_usd;
      if (price == null) return { error: 'that product has no price at this store; choose another' };
      const food = d.usda_fdc_id == null ? null : ctx.seen.foods[d.usda_fdc_id];
      if (d.usda_fdc_id != null && !food) return { error: `fdc_id ${d.usda_fdc_id} wasn't in your search_usda results; search first` };
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
        grams: d.grams,
        fraction: share.fraction,
        packages: share.packages,
        cost_used_usd: share.cost_used_usd,
        cost_to_buy_usd: share.cost_to_buy_usd,
        usda: food ? { fdc_id: food.fdc_id, description: food.description } : null,
        nutrition: nutritionFor(food, d.grams),
        note: [share.note, d.note].filter(Boolean).join('; ') || null,
      };
      const e = ctx.basket[d.line - 1];
      return { result: { recorded: d.line, cost_used_usd: e.cost_used_usd, packages_to_buy: e.packages, nutrition: e.nutrition, note: e.note, remaining_lines: remaining() } };
    }
    case 'skip_ingredient': {
      const parsed = z
        .object({ line: lineSchema(lines.length), reason: z.string().min(1), grams: z.number().positive().nullish(), usda_fdc_id: z.number().int().nullish() })
        .safeParse(input);
      if (!parsed.success) return { error: `check the input: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
      const d = parsed.data;
      const food = d.usda_fdc_id == null ? null : ctx.seen.foods[d.usda_fdc_id];
      if (d.usda_fdc_id != null && !food) return { error: `fdc_id ${d.usda_fdc_id} wasn't in your search_usda results; search first` };
      const ing = lines[d.line - 1];
      ctx.basket[d.line - 1] = {
        line: d.line,
        ingredient: ing.name,
        raw: ing.raw ?? null,
        status: 'skipped',
        reason: d.reason,
        grams: d.grams ?? null,
        cost_used_usd: 0,
        usda: food ? { fdc_id: food.fdc_id, description: food.description } : null,
        nutrition: nutritionFor(food, d.grams),
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
  const bought = basket.filter((e) => e?.status === 'bought');
  const total = round2(bought.reduce((s, e) => s + e.cost_used_usd, 0));
  const byProduct = new Map();
  for (const e of bought) {
    const p = byProduct.get(e.product.id) ?? { fraction: 0, price: e.product.price_usd };
    p.fraction += e.fraction;
    byProduct.set(e.product.id, p);
  }
  const toBuy = round2([...byProduct.values()].reduce((s, p) => s + Math.max(1, Math.ceil(p.fraction - 1e-9)) * p.price, 0));
  const nutrition = Object.fromEntries(NUTRIENTS.map((k) => [k, round2(basket.reduce((s, e) => s + (e?.nutrition?.[k] ?? 0), 0))]));
  nutrition.lines_without_nutrition = basket.filter((e) => e?.status === 'bought' && !e.nutrition).length;
  return { total, toBuy, nutrition };
}

// ------------------------------------------------------------------ one recipe
function firstMessage(recipe, store) {
  const lines = recipe.ingredients.map((i, n) => `${n + 1}. ${i.name}: ${i.raw || 'no amount given'}`).join('\n');
  return `Price this recipe at ${store.name} (${store.address}), store_id ${store.store_id}.

Recipe: ${recipe.name}
Serves about ${recipe.est_servings ?? 'an unknown number of'} people.
Ingredient lines:
${lines}`;
}

const step = (claimed, s) => getStore().addPricerStep({ meal_id: claimed.meal_id, attempt: claimed.attempts, ...s });

async function priceOne(claimed, deadline) {
  const store = getStore();
  const { model } = pricerSettings();
  const recipe = claimed.recipe;
  if (!recipe) return store.finishPricing(claimed.meal_id, { status: 'failed', error: 'the recipe was deleted' });

  let shop;
  try {
    shop = await classStore();
  } catch (e) {
    await step(claimed, { kind: 'error', text: e.message });
    return store.finishPricing(claimed.meal_id, { status: 'failed', error: e.message });
  }

  // Carry on from where an earlier run stopped, or start fresh.
  const saved = claimed.messages;
  const ctx = {
    recipe,
    store: shop,
    basket: Array.from({ length: recipe.ingredients.length }, (_, i) => (claimed.basket || []).find((e) => e?.line === i + 1) ?? null),
    seen: saved?.seen ?? { products: {}, foods: {} },
  };
  const messages = saved?.messages ?? [{ role: 'user', content: firstMessage(recipe, shop) }];
  const prompt = saved?.prompt ?? (await currentPrompt()); // a run keeps the prompt it started with
  let nudges = saved?.nudges ?? 0;
  let toolCalls = claimed.tool_calls ?? 0;
  if (!saved) await step(claimed, { kind: 'thought', text: `Pricing ${recipe.name} at ${shop.name} (store ${shop.store_id}) with ${model}.` });

  const save = () => store.savePricingProgress(claimed.meal_id, {
    messages: { messages, seen: ctx.seen, nudges, prompt },
    basket: ctx.basket.filter(Boolean),
    toolCalls,
    storeId: shop.store_id,
  });
  const fail = async (error) => {
    await step(claimed, { kind: 'error', text: error });
    await store.finishPricing(claimed.meal_id, { status: 'failed', error, basket: ctx.basket.filter(Boolean) });
  };

  while (true) {
    if (Date.now() > deadline) {
      await save();
      await store.releasePricing(claimed.meal_id); // the next run carries on
      return;
    }
    let response;
    try {
      response = await callModel({ model, max_tokens: 16000, system: prompt, tools: TOOLS, messages });
    } catch (e) {
      const retry = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError;
      if (retry) {
        await step(claimed, { kind: 'error', text: `The AI service is busy (${e.message}); trying again shortly.` });
        await save();
        await store.releasePricing(claimed.meal_id);
        return;
      }
      if (e instanceof Anthropic.AuthenticationError) return fail('The AI service rejected ANTHROPIC_API_KEY: the instructor should check it in Vercel.');
      return fail(`The AI service returned an error: ${e.message}`);
    }

    if (response.stop_reason === 'refusal') return fail('The model declined to price this recipe.');
    for (const b of response.content) if (b.type === 'text' && b.text.trim()) await step(claimed, { kind: 'thought', text: b.text.trim() });
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'max_tokens') return fail('The model’s answer was too long.');

    const uses = response.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      nudges += 1;
      if (nudges > LIMITS.nudges) return fail('The model stopped without finishing the basket.');
      messages.push({ role: 'user', content: 'Carry on: record or skip every remaining line, then call finish.' });
      await save();
      continue;
    }

    const results = [];
    let finished = null;
    for (const use of uses) {
      toolCalls += 1;
      await step(claimed, { kind: 'tool_call', tool: use.name, input: use.input });
      let out;
      try {
        out = await runTool(use.name, use.input, ctx);
      } catch (e) {
        out = { error: e.message };
      }
      if (out.error) await step(claimed, { kind: 'error', tool: use.name, text: out.error });
      else await step(claimed, { kind: 'tool_result', tool: use.name, output: out.result });
      if (out.finish) finished = out.finish;
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out.error ? { error: out.error } : out.result), ...(out.error && { is_error: true }) });
    }
    messages.push({ role: 'user', content: results });

    if (finished) {
      const basket = ctx.basket.filter(Boolean);
      const t = totals(basket);
      const { summary, people } = finished;
      await step(claimed, { kind: 'final', text: summary, output: { people, cart_usd: t.toBuy, cost_used_usd: t.total, nutrition_total: t.nutrition } });
      await store.finishPricing(claimed.meal_id, { status: 'priced', summary, people, prompt, basket, total: t.total, toBuy: t.toBuy, nutrition: t.nutrition });
      return;
    }
    if (toolCalls >= LIMITS.toolCalls) return fail(`Reached the limit of ${LIMITS.toolCalls} tool calls before finishing.`);
    await save();
  }
}

// ------------------------------------------------------------------ the queue
// Prices waiting recipes one after another until none are left or time runs out.
export async function runQueue({ budgetMs = LIMITS.runMs } = {}) {
  if (pricerProblem()) return 0;
  const deadline = Date.now() + budgetMs;
  let done = 0;
  while (Date.now() < deadline) {
    const claimed = await getStore().claimPricing({ maxActive: LIMITS.maxActive });
    if (!claimed) break;
    await priceOne(claimed, deadline);
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

// Called when someone looks at the Pricer or Database page: starts a run if
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
