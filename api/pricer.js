// The Pricer agent: what it's doing, and the controls.
//
//   GET  /api/pricer                    every recipe and its price, and the agent's latest steps   (anyone)
//   GET  /api/pricer?meal_id=…          one recipe: its shopping cart and every step               (anyone)
//   GET  /api/pricer?test=latest|<id>   the latest (or one) test run                              (anyone)
//   POST /api/pricer?action=…
//     anyone:
//        test            body {"ingredients": ["1 onion", …], "serves": 4} runs the agent on a short list;
//                        nothing is saved to the recipes (one at a time, 30 an hour)
//        price           body {"meal_id": "…"} prices that recipe (again) from scratch
//        price-unpriced  prices every recipe without a price (cleared, or couldn't be priced)
//     instructor, with Authorization: Bearer <ADMIN_KEY>:
//        prompt          body {"prompt": "…"} saves the agent's instructions; {"reset": true} goes back to the default
//        test            with "prompt": a draft of the instructions
//        clear-all       body {"confirm": "CLEAR"} removes every price (recipes stay unpriced until asked)
//        reprice-all     body {"confirm": "REPRICE"} prices every recipe again
import { getStore } from '../lib/store/index.js';
import { checkAdmin } from '../lib/admin.js';
import { json, guarded } from '../lib/http.js';
import { createHash } from 'node:crypto';
import { pricerInfo, currentPrompt, DEFAULT_PROMPT, SAMPLE_INGREDIENTS, kickPricer, resumePricer, runQueue, startTest } from '../lib/pricer.js';

const md5 = (text) => createHash('md5').update(text).digest('hex');

export const GET = guarded(async (request) => {
  const url = new URL(request.url);
  const store = getStore();
  await resumePricer(); // restart a run if recipes are waiting or one stopped part-way
  const test = url.searchParams.get('test');
  if (test) {
    const t = await store.getPricerTest(test === 'latest' ? null : test);
    return t ? json(200, t) : json(404, { errors: ['No test runs yet.'] });
  }
  const mealId = url.searchParams.get('meal_id');
  if (mealId) {
    const pricing = await store.getPricing(mealId);
    if (!pricing) return json(404, { errors: [`no pricing for meal_id ${mealId}`] });
    return json(200, { ...pricing, prompt_current: pricing.prompt == null ? null : pricing.prompt === (await currentPrompt()) });
  }
  const prompt = await currentPrompt();
  const current = md5(prompt);
  const pricings = (await store.listPricings({ limit: 300 })).map(({ prompt_md5, ...p }) => ({ ...p, prompt_current: prompt_md5 == null ? null : prompt_md5 === current }));
  const counts = Object.fromEntries(['unpriced', 'pending', 'pricing', 'priced', 'failed'].map((s) => [s, pricings.filter((p) => p.status === s).length]));
  const activity = await store.recentPricerSteps(40);
  return json(200, { ...pricerInfo(), prompt, prompt_is_default: prompt === DEFAULT_PROMPT, default_prompt: DEFAULT_PROMPT, sample_ingredients: SAMPLE_INGREDIENTS, counts, pricings, activity });
});

const OPEN = new Set(['test', 'price', 'price-unpriced']);

export const POST = guarded(async (request) => {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';
  let body = {};
  try {
    body = request.headers.get('content-length') === '0' ? {} : await request.json();
  } catch {
    body = {};
  }
  // Trying a draft of the instructions is the instructor's; a plain test is anyone's.
  if (!OPEN.has(action) || (action === 'test' && body.prompt)) {
    const auth = checkAdmin(request);
    if (!auth.ok) return json(auth.status, { errors: [auth.error] });
  }
  const store = getStore();
  switch (action) {
    case 'prompt': {
      if (body.reset) {
        await store.setPricerConfig('prompt', null);
        return json(200, { saved: true, prompt: DEFAULT_PROMPT });
      }
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (prompt.length < 50) return json(400, { errors: ['The prompt is too short: give the agent its instructions (at least 50 characters).'] });
      if (prompt.length > 20000) return json(400, { errors: ['The prompt is too long (at most 20,000 characters).'] });
      await store.setPricerConfig('prompt', prompt);
      return json(200, { saved: true, prompt, note: 'Recipes priced from now on use this prompt. Use "Reprice" to re-price earlier ones.' });
    }
    case 'test': {
      const res = await startTest(body);
      return res.ok ? json(202, { started: true, id: res.id }) : json(res.status, { errors: res.errors });
    }
    case 'price': {
      const mealId = String(body.meal_id ?? '');
      if (!(await store.resetPricing(mealId))) return json(404, { errors: [`no recipe has meal_id ${mealId}`] });
      kickPricer();
      return json(200, { queued: mealId });
    }
    case 'price-unpriced': {
      const n = await store.queueUnpriced();
      kickPricer();
      return json(200, { queued: n });
    }
    case 'clear-all': {
      if (body.confirm !== 'CLEAR') return json(400, { errors: ['Send {"confirm": "CLEAR"} to remove every price.'] });
      return json(200, { cleared: await store.clearPricings() });
    }
    case 'reprice-all': {
      if (body.confirm !== 'REPRICE') return json(400, { errors: ['Send {"confirm": "REPRICE"} to price every recipe again.'] });
      const n = await store.resetPricings({ onlyFailed: false });
      kickPricer();
      return json(200, { queued: n });
    }
    // Older names, kept for scripts.
    case 'run':
      kickPricer();
      return json(200, { started: true });
    case 'retry-failed': {
      const n = await store.resetPricings({ onlyFailed: true });
      kickPricer();
      return json(200, { queued: n });
    }
    default:
      return json(404, { errors: [`unknown action "${action}"`] });
  }
});

// Tests run the queue directly.
export { runQueue };
