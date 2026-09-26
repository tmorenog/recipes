// The Pricer Agent works through the coordinator over MCP, like every other
// agent: it reads the recipe it was given and saves its cart with
// save_pricing, and the coordinator checks the cart and works out the costs.
// Only the site's own agents (the admin key) can save prices or the class's
// choice; the class key can't.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../api/mcp.js';
import * as rest from '../api/recipes.js';
import * as pricerApi from '../api/pricer.js';
import { GET as exchangesApi } from '../api/exchanges.js';
import { getStore } from '../lib/store/index.js';
import { setPricerForTests, runQueue } from '../lib/pricer.js';
import { priceShare } from '../lib/units.js';
import { resetKroger } from '../lib/kroger.js';
import { BACKENDS, CLASS_KEY, as, recipe, closeDatabase } from './helpers.js';

const ADMIN_KEY = 'admin-key-for-tests';
process.env.ADMIN_KEY = ADMIN_KEY;
process.env.KROGER_CLIENT_ID = 'test-id';
process.env.KROGER_CLIENT_SECRET = 'test-secret';

async function rpc(key, agent, method, params, group = 'pricer') {
  const res = await handle(new Request(`http://x/api/mcp${agent ? `?agent=${agent}` : ''}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'x-group': group, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  return (await res.json());
}
const toolNames = async (key, agent) => (await rpc(key, agent, 'tools/list', {})).result.tools.map((t) => t.name).sort();
async function call(key, name, args, agent = 'pricer') {
  const body = await rpc(key, agent, 'tools/call', { name, arguments: args });
  if (body.error) return { error: body.error.message };
  const text = body.result.content.map((c) => c.text).join('\n');
  let json = null;
  try { json = JSON.parse(text); } catch { /* a rejection is text */ }
  return { isError: Boolean(body.result.isError), text, json };
}
const site = (name, args) => call(ADMIN_KEY, name, args);

async function saveRecipe(overrides = {}) {
  const r = recipe(overrides);
  const res = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as('team-1'), 'content-type': 'application/json' }, body: JSON.stringify(r) }));
  assert.equal(res.status, 201, await res.clone().text());
  return r;
}
const product = { id: '0001', description: 'Kroger Garbanzo Beans', brand: 'Kroger', size: '15.5 oz', price_usd: 0.99, image_url: 'https://www.kroger.com/product/images/medium/front/0001' };
const goodLines = [
  { line: 1, status: 'bought', product, amount_used: 5000, unit_used: 'g' },
  { line: 2, status: 'skipped', reason: 'to taste' },
];

after(async () => {
  setPricerForTests({ model: null, fetch: null, auto: true });
  await closeDatabase();
});

for (const backend of BACKENDS) {
  describe(`the Pricer Agent on the coordinator, with the ${backend.name} store`, { skip: backend.skip }, () => {
    let db;
    beforeEach(async () => {
      db = await backend.fresh();
      resetKroger();
      setPricerForTests({ model: null, fetch: null, auto: false });
    });

    test('only the site’s own agents get the tools that save prices and the class’s choice', async () => {
      assert.deepEqual(await toolNames(CLASS_KEY, 'pricer'), ['get_contract']);
      assert.deepEqual(await toolNames(ADMIN_KEY, 'pricer'), ['get_contract', 'get_recipe_to_price', 'save_pricing']);
      assert.deepEqual(await toolNames(CLASS_KEY, 'shopper'), ['get_contract', 'get_plan_ingredients', 'list_meal_plans']);
      assert.deepEqual(await toolNames(ADMIN_KEY, 'shopper'), ['get_contract', 'get_plan_ingredients', 'list_meal_plans', 'save_choice']);
      assert.ok(!(await toolNames(CLASS_KEY, null)).some((n) => ['save_pricing', 'get_recipe_to_price', 'save_choice'].includes(n)));
      assert.deepEqual(await toolNames(CLASS_KEY, 'scout'), ['get_contract', 'save_recipe'], 'the students’ agents are unchanged');

      // Calling a hidden tool with the class key does nothing.
      const r = await saveRecipe();
      const claimed = await getStore().claimPricing();
      const sneaky = await call(CLASS_KEY, 'save_pricing', { meal_id: r.meal_id, pricing_id: claimed.claim_token, people: 1, lines: goodLines });
      assert.ok(sneaky.error || sneaky.isError, 'the class key can’t save a price');
      assert.equal((await getStore().pricingClaim(r.meal_id)).status, 'pricing');
      const choice = await call(CLASS_KEY, 'save_choice', { plan_id: '00000000-0000-0000-0000-000000000000', reason: 'x'.repeat(30), cart: { people: 1, lines: [], total_usd: 0 } }, 'shopper');
      assert.ok(choice.error || choice.isError, 'the class key can’t save the class’s choice');
    });

    test('get_contract explains the Pricer Agent’s role, tools, format and checks', async () => {
      const c = await site('get_contract', {});
      assert.equal(c.json.agent, 'Pricer Agent');
      assert.deepEqual(Object.keys(c.json.tools), ['get_contract', 'get_recipe_to_price', 'save_pricing']);
      assert.ok(c.json.pricing_format.lines && c.json.pricing_format.pricing_id);
      assert.ok(c.json.checks.some((x) => /exactly once/.test(x)));
    });

    test('get_recipe_to_price serves only a recipe the site handed to a run, with numbered lines', async () => {
      const r = await saveRecipe();
      const waiting = await site('get_recipe_to_price', { meal_id: r.meal_id });
      assert.equal(waiting.isError, true);
      assert.match(waiting.text, /isn’t waiting for a price/);
      const unknown = await site('get_recipe_to_price', { meal_id: 'nope' });
      assert.match(unknown.text, /no recipe has meal_id nope/);

      const claimed = await getStore().claimPricing();
      const got = await site('get_recipe_to_price', { meal_id: r.meal_id });
      assert.equal(got.isError, false, got.text);
      assert.equal(got.json.pricing_id, claimed.claim_token);
      assert.deepEqual(got.json.lines, [
        { line: 1, ingredient: 'chickpeas', measure: '400g tin chickpeas' },
        { line: 2, ingredient: 'salt', measure: 'to taste' },
      ]);
    });

    test('save_pricing checks the cart, lists every problem at once, and saves nothing until it is right', async () => {
      const r = await saveRecipe();
      const { claim_token: token } = await getStore().claimPricing();
      const base = { meal_id: r.meal_id, pricing_id: token, people: 50 };

      const bad = await site('save_pricing', {
        ...base,
        lines: [
          { line: 1, status: 'bought', product, amount_used: 5000, unit_used: 'furlongs' },
          { line: 1, status: 'skipped', reason: 'dup' },
          { line: 3, status: 'skipped', reason: 'no such line' },
        ],
      });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /line 1 is priced twice/);
      assert.match(bad.text, /only 2 ingredient lines/);
      assert.match(bad.text, /these lines aren't in the cart: 2/);
      assert.match(bad.text, /unknown unit "furlongs"/);

      const reasons = await site('save_pricing', {
        ...base,
        lines: [
          { line: 1, status: 'estimated', product: { ...product, id: 'estimate-1', estimated: true }, amount_used: 400, unit_used: 'g' },
          { line: 2, status: 'skipped' },
        ],
      });
      assert.match(reasons.text, /an estimated line needs a reason/);
      assert.match(reasons.text, /a skipped line needs a reason/);

      const noProduct = await site('save_pricing', { ...base, lines: [{ line: 1, status: 'bought' }, goodLines[1]] });
      assert.match(noProduct.text, /needs product, amount_used and unit_used/);
      const noPeople = await site('save_pricing', { meal_id: r.meal_id, pricing_id: token, lines: goodLines });
      assert.match(noPeople.text, /people: required/);
      const both = await site('save_pricing', { ...base, lines: goodLines, could_not_price: 'nothing at Kroger' });
      assert.match(both.text, /either lines or could_not_price/);
      const costs = await site('save_pricing', { ...base, lines: [{ ...goodLines[0], cost_used_usd: 0.01 }, goodLines[1]] });
      assert.match(costs.text, /cost_used_usd/, 'costs are not the agent’s to send');

      assert.equal((await getStore().pricingClaim(r.meal_id)).status, 'pricing', 'nothing was saved');
    });

    test('the coordinator works out the costs itself and stores the price the Meal Planners see', async () => {
      const r = await saveRecipe();
      const { claim_token: token } = await getStore().claimPricing();
      const saved = await site('save_pricing', {
        meal_id: r.meal_id, pricing_id: token, people: 50, summary: 'Twelve cans.',
        lines: [{ ...goodLines[0], product: { ...product, image_url: 'https://evil.example/x.jpg' } }, goodLines[1]],
      });
      assert.equal(saved.isError, false, saved.text);
      const share = priceShare({ amount: 5000, unitName: 'g', size: '15.5 oz', price: 0.99 });
      assert.deepEqual(
        { per: saved.json.cost_per_serving_usd, used: saved.json.cost_used_usd, cart: saved.json.cart_usd, skipped: saved.json.skipped_lines },
        { per: Math.round((share.cost_used_usd / 50) * 100) / 100, used: share.cost_used_usd, cart: share.cost_to_buy_usd, skipped: 1 },
      );
      assert.match(saved.json.format_notes[0], /wasn’t a Kroger product photo/);

      const p = await getStore().getPricing(r.meal_id);
      assert.equal(p.status, 'priced');
      assert.equal(p.basket[0].packages, 12);
      assert.equal(p.basket[0].product.image_url, null);
      const list = await (await rest.GET(new Request('http://x/api/recipes?status=all'))).json();
      assert.equal(list.recipes[0].pricing.cost_per_serving_usd, 0.23);

      // The same run can't save twice, and a stale pricing_id is turned away.
      const again = await site('save_pricing', { meal_id: r.meal_id, pricing_id: token, people: 50, lines: goodLines });
      assert.match(again.text, /no longer holds the recipe/);
    });

    test('could_not_price records why, even when the recipe was deleted', async () => {
      const r = await saveRecipe();
      const { claim_token: token } = await getStore().claimPricing();
      await db.pool.query('delete from recipes where meal_id = $1', [r.meal_id]);
      const noRecipe = await site('save_pricing', { meal_id: r.meal_id, pricing_id: token, people: 4, lines: goodLines });
      assert.match(noRecipe.text, /the recipe was deleted/);
      const failed = await site('save_pricing', { meal_id: r.meal_id, pricing_id: token, could_not_price: 'the recipe was deleted' });
      assert.equal(failed.json.status, 'failed');
      assert.equal((await getStore().pricingClaim(r.meal_id)).status, 'failed');
    });

    test('a Pricer run reads its recipe and saves its cart over MCP, and both show on the Coordinator page', async () => {
      const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
      const script = [
        [toolUse('a', 'search_kroger', { term: 'chickpeas' })],
        [toolUse('b', 'record_ingredient', { line: 1, kroger_product_id: '0001', amount_used: 5000, unit_used: 'g', note: 'drained' }), toolUse('c', 'skip_ingredient', { line: 2, reason: 'to taste' })],
        [toolUse('d', 'finish', { people: 50, summary: 'Twelve cans.' })],
      ];
      const seen = [];
      setPricerForTests({
        auto: false,
        fetch: fakeKroger,
        model: async (params) => {
          seen.push(params);
          return { stop_reason: 'tool_use', content: script[params.messages.filter((m) => m.role === 'assistant').length] };
        },
      });
      const r = await saveRecipe();
      assert.equal(await runQueue(), 1);
      const p = await getStore().getPricing(r.meal_id);
      assert.equal(p.status, 'priced');
      assert.equal(p.basket[0].note.includes('drained'), true, 'the agent’s own note is kept');
      assert.equal(p.prompt != null, true, 'the prompt the run used is kept with the price');
      const finishAnswer = seen.at(-1).messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.tool_use_id === 'd');
      assert.match(finishAnswer.content, /"cost_per_serving_usd": ?0\.23/, 'the agent sees the coordinator’s answer to its cart');

      const { exchanges } = await (await exchangesApi(new Request('http://x/api/exchanges?limit=50'))).json();
      const pricer = exchanges.filter((x) => x.agent === 'pricer').map((x) => [x.tool, x.ok]);
      assert.deepEqual(pricer, [['save_pricing', true], ['get_recipe_to_price', true]]);
      const saveRow = exchanges.find((x) => x.tool === 'save_pricing');
      assert.match(saveRow.summary, /cart checked and stored: \$0\.23 a serving/);
      assert.match(saveRow.request_summary, /a cart of 2 lines for 50 people/);
      const steps = p.steps.map((s) => s.kind);
      assert.equal(steps.at(-1), 'final', 'the run logs its last step after saving');
    });

    test('a cart the coordinator rejects goes back to the agent, which fixes it', async () => {
      const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
      // The agent labels a bought product as a substitute with an over-long note: the coordinator rejects it.
      const script = [
        [toolUse('a', 'search_kroger', { term: 'chickpeas' })],
        [toolUse('b', 'record_ingredient', { line: 1, kroger_product_id: '0001', amount_used: 5000, unit_used: 'g', note: 'x'.repeat(600) }), toolUse('c', 'skip_ingredient', { line: 2, reason: 'to taste' })],
        [toolUse('d', 'finish', { people: 50, summary: 'First try.' })],
        [toolUse('e', 'record_ingredient', { line: 1, kroger_product_id: '0001', amount_used: 5000, unit_used: 'g', note: 'short' })],
        [toolUse('f', 'finish', { people: 50, summary: 'Fixed.' })],
      ];
      const results = [];
      setPricerForTests({
        auto: false,
        fetch: fakeKroger,
        model: async (params) => {
          const last = params.messages.at(-1);
          if (last.role === 'user' && Array.isArray(last.content)) results.push(...last.content);
          return { stop_reason: 'tool_use', content: script[params.messages.filter((m) => m.role === 'assistant').length] };
        },
      });
      const r = await saveRecipe();
      assert.equal(await runQueue(), 1);
      const rejected = results.find((x) => x.is_error && /coordinator rejected the cart/.test(x.content));
      assert.ok(rejected, 'the rejection came back to the agent');
      const p = await getStore().getPricing(r.meal_id);
      assert.equal(p.status, 'priced');
      assert.equal(p.summary, 'Fixed.');
    });

    test('a run whose recipe is reset while it works stops without saving', async () => {
      const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
      let r;
      const script = [
        [toolUse('a', 'search_kroger', { term: 'chickpeas' })],
        [toolUse('b', 'record_ingredient', { line: 1, kroger_product_id: '0001', amount_used: 5000, unit_used: 'g' }), toolUse('c', 'skip_ingredient', { line: 2, reason: 'to taste' })],
        [toolUse('d', 'finish', { people: 50, summary: 'Too late.' })],
      ];
      setPricerForTests({
        auto: false,
        fetch: fakeKroger,
        model: async (params) => {
          const turn = params.messages.filter((m) => m.role === 'assistant').length;
          // The instructor asks for a new price just before the agent finishes.
          if (turn === 2) await db.pool.query("update pricings set status = 'pending', claim_token = null where meal_id = $1", [r.meal_id]);
          return { stop_reason: 'tool_use', content: script[turn] };
        },
      });
      r = await saveRecipe();
      await runQueue({ budgetMs: 5000 });
      const p = await getStore().getPricing(r.meal_id);
      assert.notEqual(p.summary, 'Too late.');
      assert.notEqual(p.status, 'priced');
    });

    test('the Pricer page still shows the queue and each cart', async () => {
      const r = await saveRecipe();
      const { claim_token: token } = await getStore().claimPricing();
      await site('save_pricing', { meal_id: r.meal_id, pricing_id: token, people: 50, lines: goodLines });
      const page = await (await pricerApi.GET(new Request(`http://x/api/pricer?meal_id=${r.meal_id}`))).json();
      assert.equal(page.status, 'priced');
      assert.equal(page.basket.length, 2);
      assert.ok(!('claim_token' in page));
    });
  });
}

const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
async function fakeKroger(url) {
  const u = String(url);
  if (u.includes('/connect/oauth2/token')) return reply({ access_token: 't', expires_in: 1800 });
  if (u.includes('/locations')) return reply({ data: [{ locationId: '01400943', name: 'Kroger Test', chain: 'KROGER', address: { addressLine1: '1 Main St', city: 'Cincinnati', state: 'OH', zipCode: '45202' } }] });
  if (u.includes('/products')) return reply({ data: [{ productId: '0001', description: 'Kroger Garbanzo Beans', brand: 'Kroger', items: [{ size: '15.5 oz', price: { regular: 0.99, promo: 0 } }], images: [] }] });
  throw new Error(`unexpected fetch ${u}`);
}
