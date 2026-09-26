// Fixes from an outside review: one run at a time under simultaneous
// requests, clearing the class's plan stops a running Shopper, TheMealDB
// hiccups aren't remembered as missing recipes, no tool runs after finish or
// past the action limit, and malformed MCP bodies get a JSON-RPC error.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../api/mcp.js';
import * as rest from '../api/recipes.js';
import * as plansApi from '../api/meal-plans.js';
import { getStore } from '../lib/store/index.js';
import { lookupMeal, setMealDbForTests } from '../lib/mealdb.js';
import { setBackupForTests, startBackupRun } from '../lib/backup-agents.js';
import { setPricerForTests, runQueue } from '../lib/pricer.js';
import { resetKroger } from '../lib/kroger.js';
import { BACKENDS, CLASS_KEY, as, recipe, markPriced, closeDatabase } from './helpers.js';

process.env.ADMIN_KEY = 'admin-key-for-tests';
process.env.KROGER_CLIENT_ID = 'test-id';
process.env.KROGER_CLIENT_SECRET = 'test-secret';

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

after(async () => {
  setBackupForTests({ model: null, fetch: null, background: true });
  setPricerForTests({ model: null, fetch: null, auto: true });
  setMealDbForTests({ fetch: null, enabled: null });
  await closeDatabase();
});

for (const backend of BACKENDS) {
  describe(`review fixes, with the ${backend.name} store`, { skip: backend.skip }, () => {
    let db;
    beforeEach(async () => {
      db = await backend.fresh();
      resetKroger();
      setMealDbForTests({ fetch: null, enabled: false });
    });

    test('only one run of an agent starts, even when five start at the same moment', async () => {
      const store = getStore();
      const tries = await Promise.all(Array.from({ length: 5 }, () => store.createBackupRun({ agent: 'shopper', group_name: 'shopper', input: {} })));
      assert.equal(tries.filter((t) => t.id).length, 1);
      assert.equal(tries.filter((t) => t.busy).length, 4);
      const scout = await store.createBackupRun({ agent: 'scout', group_name: 'x', input: {} });
      assert.ok(scout.id, 'other agents aren’t blocked');

      const tests = await Promise.all(Array.from({ length: 3 }, () => store.createPricerTest({ name: 't', ingredients: ['a'], serves: 1, prompt: 'p', draft: false }, { perHour: 30 })));
      assert.equal(tests.filter((t) => t.id).length, 1, 'one Pricer test at a time');
      assert.equal(tests.filter((t) => t.busy).length, 2);
    });

    test('clearing the class’s plan stops a running Shopper before it saves', async () => {
      let release;
      const gate = new Promise((r) => { release = r; });
      let calls = 0;
      setBackupForTests({
        background: true,
        model: async () => {
          calls += 1;
          if (calls === 1) await gate; // the instructor clears the plan while the model thinks
          return { stop_reason: 'tool_use', content: [toolUse(`t${calls}`, 'save_choice', { plan_id: '00000000-0000-0000-0000-000000000000', reason: 'A reason long enough to be accepted.' })] };
        },
      });
      const started = await startBackupRun({ agent: 'shopper' });
      assert.ok(started.ok, JSON.stringify(started));
      await new Promise((r) => setTimeout(r, 50));
      await getStore().clearChoices();
      release();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(calls, 1, 'the model isn’t asked again');
      assert.equal((await db.pool.query('select count(*)::int as n from backup_runs')).rows[0].n, 0);
      assert.equal((await db.pool.query('select count(*)::int as n from class_choices')).rows[0].n, 0);
    });

    test('an unexpected TheMealDB answer is a hiccup, not a missing recipe, and isn’t remembered', async () => {
      setMealDbForTests({ enabled: null, fetch: async () => new Response('<h1>Down for maintenance</h1>', { status: 200, headers: { 'content-type': 'text/html' } }) });
      assert.equal((await lookupMeal('52772')).status, 'unreachable');
      setMealDbForTests({ fetch: async () => reply({ meals: null }) });
      assert.equal((await lookupMeal('52772')).status, 'missing', 'the maintenance page wasn’t cached');
      setMealDbForTests({ fetch: async () => reply({ meals: [{ idMeal: '52773', strMeal: 'Real', strIngredient1: 'Rice' }] }) });
      assert.equal((await lookupMeal('52773')).status, 'found');
    });

    test('a backup agent runs no tool after finish, or past its action limit, in one answer', async () => {
      setBackupForTests({
        background: false,
        fetch: async () => reply({ meals: [] }),
        model: async () => ({ stop_reason: 'tool_use', content: [toolUse('a', 'finish', { summary: 'Done.' }), toolUse('b', 'search_meals', { name: 'rice' })] }),
      });
      let fetched = 0;
      setBackupForTests({ fetch: async () => { fetched += 1; return reply({ meals: [] }); } });
      const started = await startBackupRun({ agent: 'scout', group: 'team-1', theme: 'rice' });
      const run = await getStore().getBackupRun(started.id);
      assert.equal(fetched, 0, 'the search after finish never ran');
      assert.equal(run.status, 'done');
    });

    test('the Pricer runs nothing after its cart is saved, even in the same answer', async () => {
      const script = [
        [toolUse('a', 'search_kroger', { term: 'chickpeas' })],
        [toolUse('b', 'record_ingredient', { line: 1, kroger_product_id: '0001', amount_used: 5000, unit_used: 'g' }), toolUse('c', 'skip_ingredient', { line: 2, reason: 'to taste' })],
        [toolUse('d', 'finish', { people: 50, summary: 'Done.' }), toolUse('e', 'skip_ingredient', { line: 1, reason: 'changed my mind' })],
      ];
      setPricerForTests({
        auto: false,
        fetch: async (url) => {
          const u = String(url);
          if (u.includes('oauth2')) return reply({ access_token: 't', expires_in: 1800 });
          if (u.includes('/locations')) return reply({ data: [{ locationId: '01400943', name: 'Kroger Test', chain: 'KROGER', address: { addressLine1: '1 Main St', city: 'X', state: 'OH', zipCode: '45202' } }] });
          return reply({ data: [{ productId: '0001', description: 'Kroger Garbanzo Beans', brand: 'Kroger', items: [{ size: '15.5 oz', price: { regular: 0.99, promo: 0 } }], images: [] }] });
        },
        model: async (params) => ({ stop_reason: 'tool_use', content: script[params.messages.filter((m) => m.role === 'assistant').length] }),
      });
      const r = recipe();
      await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as('team-1'), 'content-type': 'application/json' }, body: JSON.stringify(r) }));
      assert.equal(await runQueue(), 1);
      const p = await getStore().getPricing(r.meal_id);
      assert.equal(p.status, 'priced');
      assert.equal(p.basket[0].status, 'bought', 'the skip after finish didn’t change the cart');
    });

    test('MCP bodies that aren’t JSON-RPC messages get an invalid-request error', async () => {
      for (const body of ['null', 'false', '0', '[]', '"text"', '[1, 2]']) {
        const res = await handle(new Request('http://x/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${CLASS_KEY}`, 'x-group': 'team-1', 'content-type': 'application/json' }, body }));
        assert.equal(res.status, 400, body);
        assert.equal((await res.json()).error.code, -32600, body);
      }
    });
  });
}
