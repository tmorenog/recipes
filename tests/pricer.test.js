// The Pricer agent, end to end against Postgres, with a scripted model and
// fake Kroger and USDA answers: saving a recipe queues it, a run fills the
// shopping cart, and the page's API shows the cart and every step.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { BACKENDS, as, recipe, closeDatabase } from './helpers.js';
import { setPricerForTests, runQueue, totals, DEFAULT_PROMPT } from '../lib/pricer.js';
import { resetKroger } from '../lib/kroger.js';
import * as recipesApi from '../api/recipes.js';
import * as pricerApi from '../api/pricer.js';

process.env.KROGER_CLIENT_ID = 'test-id';
process.env.KROGER_CLIENT_SECRET = 'test-secret';
process.env.ADMIN_KEY = 'admin-key-for-tests';

const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const calls = { kroger: 0, usda: 0 };
async function fakeFetch(url) {
  const u = String(url);
  if (u.includes('/connect/oauth2/token')) return reply({ access_token: 't', expires_in: 1800 });
  if (u.includes('/locations')) {
    return reply({ data: [{ locationId: '01400943', name: 'Kroger Test', chain: 'KROGER', address: { addressLine1: '1 Main St', city: 'Cincinnati', state: 'OH', zipCode: '45202' } }] });
  }
  if (u.includes('/products')) {
    calls.kroger += 1;
    return reply({ data: [{ productId: '0001', description: 'Kroger Garbanzo Beans', brand: 'Kroger', items: [{ size: '15.5 oz', price: { regular: 0.99, promo: 0 } }], images: [] }] });
  }
  if (u.includes('api.nal.usda.gov')) {
    calls.usda += 1;
    return reply({
      foods: [{
        fdcId: 173756,
        description: 'Chickpeas, canned, drained',
        foodCategory: 'Legumes',
        foodNutrients: [
          { nutrientNumber: '208', unitName: 'KCAL', value: 139 },
          { nutrientNumber: '203', unitName: 'G', value: 7 },
          { nutrientNumber: '291', unitName: 'G', value: 6 },
          { nutrientNumber: '307', unitName: 'MG', value: 246 },
        ],
      }],
    });
  }
  throw new Error(`unexpected fetch ${u}`);
}

// A scripted agent for the helper recipe: line 1 chickpeas, line 2 salt to taste.
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
function scriptedModel(log) {
  return async (params) => {
    log.push(params);
    const turn = params.messages.filter((m) => m.role === 'assistant').length;
    const content = [
      [{ type: 'text', text: 'Searching for chickpeas.' }, toolUse('a', 'search_kroger', { term: 'canned chickpeas' }), toolUse('b', 'search_usda', { query: 'chickpeas canned' })],
      // First a product it never searched for, to see the error come back.
      [toolUse('c', 'record_ingredient', { line: 1, kroger_product_id: '9999', amount_used: 5000, unit_used: 'g', grams: 5000, usda_fdc_id: 173756 })],
      [
        toolUse('d', 'record_ingredient', { line: 1, kroger_product_id: '0001', amount_used: 5000, unit_used: 'g', grams: 5000, usda_fdc_id: 173756 }),
        toolUse('e', 'skip_ingredient', { line: 2, reason: 'to taste, no amount' }),
      ],
      [toolUse('f', 'finish', { people: 50, summary: 'Twelve cans of chickpeas feed 50 people. Salt was skipped.' })],
    ][turn];
    return { stop_reason: 'tool_use', content };
  };
}

async function save(group, body) {
  const res = await recipesApi.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as(group), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal(res.status, 201, await res.clone().text());
}
const getJson = async (res) => ({ status: res.status, body: await res.json() });
const pricer = (query = '') => pricerApi.GET(new Request(`http://x/api/pricer${query}`)).then(getJson);
const control = (action, body = {}, key = 'admin-key-for-tests') =>
  pricerApi.POST(new Request(`http://x/api/pricer?action=${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).then(getJson);

after(async () => {
  setPricerForTests({ model: null, fetch: null, auto: true });
  await closeDatabase();
});

for (const backend of BACKENDS) {
  describe(`the Pricer, with the ${backend.name} store`, { skip: backend.skip }, () => {
    beforeEach(async () => {
      await backend.fresh();
      resetKroger();
      calls.kroger = 0;
      calls.usda = 0;
    });

    test('a saved recipe is queued, priced into a cart for 50 people, and shown with every step', async () => {
      const log = [];
      setPricerForTests({ model: scriptedModel(log), fetch: fakeFetch, auto: false });
      const r = recipe({ meal_id: '52870' });
      await save('team-1', r);
      await save('team-2', r); // the same TheMealDB recipe from another group is priced once

      let queue = (await pricer()).body;
      assert.deepEqual(queue.counts, { pending: 1, pricing: 0, priced: 0, failed: 0 });
      assert.equal(queue.prompt, DEFAULT_PROMPT);
      assert.match(queue.prompt, /50 people/);

      assert.equal(await runQueue(), 1);
      assert.equal(log[0].system, DEFAULT_PROMPT, 'the agent follows the saved prompt');
      assert.match(log[0].messages[0].content, /1\. chickpeas: 400g tin chickpeas\n2\. salt: to taste/);

      const { body: p } = await pricer('?meal_id=52870');
      assert.equal(p.status, 'priced');
      assert.equal(p.people, 50);
      assert.equal(p.basket.length, 2);
      const [chickpeas, salt] = p.basket;
      assert.equal(chickpeas.packages, 12); // 5000 g ÷ 15.5 oz cans = 11.4, so 12 cans
      assert.equal(chickpeas.cost_to_buy_usd, 11.88);
      assert.equal(chickpeas.product.description, 'Kroger Garbanzo Beans');
      assert.equal(chickpeas.nutrition.calories, 6950);
      assert.equal(salt.status, 'skipped');
      assert.equal(p.to_buy_usd, 11.88);
      assert.equal(p.total_cost_usd, 11.26); // 11.38 cans' worth at $0.99
      assert.ok(!('messages' in p), 'the conversation itself stays private');

      const kinds = p.steps.map((s) => s.kind);
      assert.equal(kinds.at(-1), 'final');
      assert.ok(kinds.includes('error'), 'the bad product id shows as an error step');
      assert.match(p.steps.find((s) => s.kind === 'error').text, /wasn't in your search_kroger results/);

      // Planners see the price per serving with each recipe.
      const list = await recipesApi.GET(new Request('http://x/api/recipes?status=all')).then(getJson);
      assert.deepEqual(list.body.recipes[0].pricing, {
        status: 'priced',
        people: 50,
        cart_usd: 11.88,
        cost_used_usd: 11.26,
        cost_per_serving_usd: 0.23,
        nutrition_per_serving: { calories: 139, protein_g: 7, fiber_g: 6, sodium_mg: 246 },
      });

      queue = (await pricer()).body;
      assert.deepEqual(queue.counts, { pending: 0, pricing: 0, priced: 1, failed: 0 });
      assert.deepEqual(queue.pricings[0].groups.sort(), ['team-1', 'team-2']);
    });

    test('Kroger and USDA searches are made once for the class', async () => {
      setPricerForTests({ model: scriptedModel([]), fetch: fakeFetch, auto: false });
      await save('team-1', recipe({ meal_id: '1' }));
      await runQueue();
      setPricerForTests({ model: scriptedModel([]) });
      await save('team-1', recipe({ meal_id: '2' }));
      await runQueue();
      assert.equal(calls.kroger, 1);
      assert.equal(calls.usda, 1);
    });

    test('the instructor edits the prompt, and prices a recipe again with it', async () => {
      const log = [];
      setPricerForTests({ model: scriptedModel(log), fetch: fakeFetch, auto: false });
      await save('team-1', recipe({ meal_id: '7' }));

      assert.equal((await control('prompt', { prompt: 'short' })).status, 400);
      assert.equal((await control('prompt', { prompt: 'x'.repeat(60) }, 'wrong-key')).status, 401);
      const custom = `${DEFAULT_PROMPT.replace('50 people', '30 people')}`;
      assert.equal((await control('prompt', { prompt: custom })).status, 200);
      assert.equal((await pricer()).body.prompt_is_default, false);

      await runQueue();
      assert.equal(log[0].system, custom);
      assert.equal((await pricer('?meal_id=7')).body.prompt, custom, 'each pricing remembers its prompt');

      assert.equal((await control('price', { meal_id: '7' })).status, 200);
      assert.equal((await pricer('?meal_id=7')).body.status, 'pending');
      assert.equal((await pricer('?meal_id=7')).body.steps.length, 0);

      assert.equal((await control('prompt', { reset: true })).body.prompt, DEFAULT_PROMPT);
      assert.equal((await control('reprice-all')).status, 400);
      assert.equal((await control('reprice-all', { confirm: 'REPRICE' })).body.queued, 1);
    });

    test('a model that stops without finishing is marked failed, with the reason', async () => {
      setPricerForTests({ model: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done, I think.' }] }), fetch: fakeFetch, auto: false });
      await save('team-1', recipe({ meal_id: '8' }));
      await runQueue();
      const { body: p } = await pricer('?meal_id=8');
      assert.equal(p.status, 'failed');
      assert.match(p.error, /stopped without finishing/);
      const list = await recipesApi.GET(new Request('http://x/api/recipes?status=all')).then(getJson);
      assert.equal(list.body.recipes[0].pricing.status, 'failed');
    });
  });
}

test('cart totals buy whole packages per product, even when two lines share one', () => {
  const line = (n, id, fraction, price, cost) => ({ line: n, status: 'bought', product: { id, price_usd: price }, fraction, cost_used_usd: cost, nutrition: { calories: 10, protein_g: 1, fiber_g: 0, sodium_mg: 5 } });
  const t = totals([line(1, 'onions', 0.6, 3.49, 2.09), line(2, 'onions', 0.6, 3.49, 2.09), { line: 3, status: 'skipped', cost_used_usd: 0, nutrition: null }]);
  assert.equal(t.total, 4.18);
  assert.equal(t.toBuy, 6.98); // 1.2 bags → 2 bags
  assert.equal(t.nutrition.calories, 20);
});
