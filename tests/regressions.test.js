// Regression tests from the code review: filtering before the limit, the
// pricing queue's claims, secret redaction, editing priced recipes,
// recipe/pick conflicts and deleting priced recipes.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as adminApi from '../api/admin.js';
import * as rest from '../api/recipes.js';
import { GET as activityApi } from '../api/activity.js';
import { GET as exchangesApi } from '../api/exchanges.js';
import { POST as mcpPost } from '../api/mcp.js';
import { getStore } from '../lib/store/index.js';
import { redactDeep } from '../lib/secrets.js';
import { saveSettings } from '../lib/settings.js';
import { setPricerForTests, runQueue } from '../lib/pricer.js';
import Anthropic from '@anthropic-ai/sdk';
import { BACKENDS, CLASS_KEY, as, recipe, markPriced, closeDatabase } from './helpers.js';

const ADMIN_KEY = 'admin-key-for-tests';
process.env.ADMIN_KEY = ADMIN_KEY;

const admin = (id, body) => adminApi.POST(new Request(`http://x/api/admin?action=recipe&id=${id}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).then(async (res) => ({ status: res.status, body: await res.json() }));

async function save(group, overrides = {}) {
  const res = await rest.POST(new Request('http://x/api/recipes', {
    method: 'POST', headers: { ...as(group), 'content-type': 'application/json' }, body: JSON.stringify(recipe(overrides)),
  }));
  const body = await res.json();
  assert.equal(res.status < 300, true, JSON.stringify(body));
  return body.recipe;
}
const list = async (query) => (await (await rest.GET(new Request(`http://x/api/recipes?${query}`))).json()).recipes;
const pricing = async (pool, mealId) => (await pool.query('select * from pricings where meal_id = $1', [mealId])).rows[0];

after(closeDatabase);

for (const backend of BACKENDS) {
  describe(`review regressions with the ${backend.name} store`, { skip: backend.skip }, () => {
    let db;
    beforeEach(async () => { db = await backend.fresh(); });

    test('priced=true filters before the limit, so older priced recipes are not cut off', async () => {
      const oldest = await save('team-1', { name: 'Oldest' });
      await markPriced(db.pool, [oldest.id]);
      for (let i = 0; i < 4; i++) await save('team-1', { name: `Newer ${i}` });

      const priced = await list('priced=true&limit=2');
      assert.deepEqual(priced.map((r) => r.name), ['Oldest']);
      const unpriced = await list('priced=false&limit=2');
      assert.equal(unpriced.length, 2);
      assert.ok(unpriced.every((r) => r.pricing.status !== 'priced'));
    });

    test('concurrent claims never exceed the limit, and a run that lost its claim cannot overwrite', async () => {
      const recipes = [];
      for (let i = 0; i < 6; i++) recipes.push(await save('team-1', { name: `R${i}` }));
      const store = getStore();
      const claims = (await Promise.all(Array.from({ length: 6 }, () => store.claimPricing({ maxActive: 2 })))).filter(Boolean);
      assert.equal(claims.length, 2, 'at most two recipes are priced at once');
      assert.notEqual(claims[0].meal_id, claims[1].meal_id);
      assert.ok(claims.every((c) => c.claim_token));

      // The instructor resets a recipe while it's being priced: the old run's writes are ignored.
      const [first] = claims;
      await store.resetPricing(first.meal_id);
      assert.equal(await store.savePricingProgress(first.meal_id, { messages: {}, basket: [], toolCalls: 1, token: first.claim_token }), false);
      assert.equal(await store.finishPricing(first.meal_id, { status: 'priced', people: 4, total: 8, toBuy: 8, basket: [], token: first.claim_token }), false);
      assert.equal((await pricing(db.pool, first.meal_id)).status, 'pending');

      // A fresh claim gets a new token; only that one counts.
      const again = await store.claimPricing({ maxActive: 3 });
      assert.ok(again && again.claim_token !== first.claim_token);
      assert.equal(await store.finishPricing(again.meal_id, { status: 'priced', people: 4, total: 8, toBuy: 8, basket: [], token: again.claim_token }), true);
      assert.equal(await store.releasePricing(again.meal_id, again.claim_token), false, 'a finished run holds no claim');
    });

    test('many saves at once finish: a save never waits on a second pool connection', { timeout: 20_000 }, async () => {
      const saved = await Promise.all(Array.from({ length: 6 }, (_, i) => save(`team-${i + 1}`, { name: `Parallel ${i}` })));
      assert.equal(saved.length, 6);
    });

    test('saves sent at the same moment cannot pass the per-group limit', async () => {
      await saveSettings({ max_recipes_per_group: 2, max_saves_per_minute: 0 });
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => rest.POST(new Request('http://x/api/recipes', {
        method: 'POST', headers: { ...as('team-1'), 'content-type': 'application/json' }, body: JSON.stringify(recipe({ name: `R${i}` })),
      }))));
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 403, 403, 403].sort());
      assert.equal((await list('status=all')).length, 2);
    });

    test('attempts turned away by the rate limit do not keep the group locked out', async () => {
      await saveSettings({ max_saves_per_minute: 2 });
      for (let i = 0; i < 2; i++) await save('team-1', { name: `R${i}` });
      for (let i = 0; i < 3; i++) {
        const res = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as('team-1'), 'content-type': 'application/json' }, body: JSON.stringify(recipe()) }));
        assert.equal(res.status, 429);
      }
      assert.equal(await getStore().recentAttempts('team-1', new Date(Date.now() - 60_000).toISOString()), 2);
    });

    test('Meal Planner Agents see every recipe, including ones marked processed', async () => {
      const r = await save('team-1');
      await markPriced(db.pool, [r.id]);
      await rest.POST(new Request(`http://x/api/recipes?id=${r.id}&action=processed`, { method: 'POST', headers: as('team-2') }));
      const call = async (agent) => {
        const res = await mcpPost(new Request(`http://x/api/mcp?agent=${agent}`, {
          method: 'POST',
          headers: { ...as('team-3'), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_recipes', arguments: { priced: true } } }),
        }));
        return JSON.parse((await res.json()).result.content[0].text).count;
      };
      assert.equal(await call('planner'), 1);
    });

    test('a busy AI service stops the pricing run instead of retrying at once', async () => {
      const env = { KROGER_CLIENT_ID: 'test-id', KROGER_CLIENT_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'sk-ant-api03-regressiontestkey0000000000' };
      const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
      Object.assign(process.env, env);
      const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      const fetch = async (url) => (String(url).includes('/locations')
        ? reply({ data: [{ locationId: '01400943', name: 'Kroger Test', chain: 'KROGER', address: { addressLine1: '1 Main St', city: 'Cincinnati', state: 'OH', zipCode: '45202' } }] })
        : reply({ access_token: 't', expires_in: 1800 }));
      let calls = 0;
      setPricerForTests({ auto: false, fetch, model: async () => { calls += 1; throw new Anthropic.RateLimitError(429, { type: 'error' }, 'busy', new Headers()); } });
      try {
        await save('team-1');
        await runQueue({ budgetMs: 2000 });
      } finally {
        setPricerForTests({ model: null, fetch: null, auto: true });
        for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      assert.equal(calls, 1, 'one call, then the run stops');
    });

    test('secrets are redacted at any depth, and the public activity log leaves out what was sent', async () => {
      assert.deepEqual(
        redactDeep({ a: [{ note: `key ${CLASS_KEY} here`, api_key: 'abc12345678', nested: { password: 'p' } }], n: 3 }),
        { a: [{ note: 'key [hidden] here', api_key: '[hidden]', nested: { password: '[hidden]' } }], n: 3 },
      );

      // A rejected save whose body quotes the class key and a secret-named field.
      const bad = recipe({ why_chosen: `because ${CLASS_KEY}`, est_servings: 0 });
      bad.extra = { token: 'tok-1234567890' };
      await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as('team-1'), 'content-type': 'application/json' }, body: JSON.stringify(bad) }));
      const [row] = await db.activity();
      const stored = JSON.stringify(row.input);
      assert.ok(!stored.includes(CLASS_KEY) && !stored.includes('tok-1234567890'), stored);

      const pub = await (await activityApi(new Request('http://x/api/activity'))).json();
      assert.equal(pub.count, 1);
      assert.ok(!('input' in pub.activity[0]), 'raw input is not public');

      // The exchange log over MCP too.
      await mcpPost(new Request('http://x/api/mcp?agent=scout', {
        method: 'POST',
        headers: { ...as('team-1'), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_recipe', arguments: { ...bad, api_key: 'sk-ant-api03-abcdefghijkl' } } }),
      }));
      const ex = await (await exchangesApi(new Request('http://x/api/exchanges'))).json();
      const text = JSON.stringify(ex.exchanges);
      assert.ok(ex.exchanges.length > 0);
      assert.ok(!text.includes(CLASS_KEY) && !text.includes('abcdefghijkl') && !text.includes('tok-1234567890'), text);
    });

    test('editing what the price depends on drops the price and queues the recipe again', async () => {
      const r = await save('team-1');
      await markPriced(db.pool, [r.id]);

      // Only the reason changes: the price stays.
      const words = await admin(r.id, { why_chosen: 'Still cheap.' });
      assert.equal(words.status, 200);
      assert.equal(words.body.repriced, false);
      assert.equal(words.body.recipe.pricing.status, 'priced');

      // Same ingredients sent again, in another key order: still no reprice.
      const same = await admin(r.id, { ingredients: r.ingredients.map((i) => Object.fromEntries(Object.entries(i).reverse())) });
      assert.equal(same.body.repriced, false);

      const servings = await admin(r.id, { est_servings: 6 });
      assert.equal(servings.body.repriced, true);
      assert.equal(servings.body.recipe.pricing.status, 'pending');
      assert.equal((await pricing(db.pool, r.meal_id)).total_cost_usd, null);

      // A new meal_id: the old price row goes, the new one is queued.
      await markPriced(db.pool, [r.id]);
      const moved = await admin(r.id, { meal_id: '424242' });
      assert.equal(moved.body.repriced, true);
      assert.equal(moved.body.recipe.pricing.status, 'pending');
      assert.equal(await pricing(db.pool, r.meal_id), undefined);
      assert.equal((await pricing(db.pool, '424242')).status, 'pending');
    });

    test('an edit that clashes with another pick changes nothing and returns 409', async () => {
      const r = await save('team-1', { theme: 'soups', name: 'Soup' });
      await save('team-2', { theme: 'soups', meal_id: r.meal_id, name: 'Soup' }); // a second pick of the same recipe

      const clash = await admin(r.id, { name: 'Renamed', group: 'team-2' });
      assert.equal(clash.status, 409);
      assert.match(clash.body.errors[0], /already picked/);
      const [after] = await list('status=all');
      assert.equal(after.name, 'Soup', 'the recipe change was rolled back too');
      assert.deepEqual(after.picks.map((p) => p.group), ['team-1', 'team-2']);
    });

    test('deleting a priced recipe works, and saving it again brings its price back', async () => {
      const r = await save('team-1');
      await markPriced(db.pool, [r.id]);
      await db.pool.query("insert into pricer_steps (meal_id, attempt, kind, text) values ($1, 1, 'thought', 'x')", [r.meal_id]);

      const del = await adminApi.POST(new Request(`http://x/api/admin?action=delete-recipe&id=${r.id}`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN_KEY}` } }));
      assert.equal(del.status, 200);
      assert.equal((await list('status=all')).length, 0);

      await save('team-2', { meal_id: r.meal_id });
      const [again] = await list('status=all');
      assert.equal(again.pricing.status, 'priced');
    });
  });
}

test('the coordinator accepts the likely ways to send the class key and group, and one rejection explains both headers', async () => {
  const { checkCaller } = await import('../lib/auth.js');
  const { CLASS_KEY } = await import('./helpers.js');
  const call = (headers, url = 'http://x/api/mcp?agent=scout') => checkCaller(new Request(url, { method: 'POST', headers }));
  assert.deepEqual(call({ authorization: `Bearer ${CLASS_KEY}`, 'x-group': 'Team 3' }), { group: 'team-3' });
  assert.deepEqual(call({ 'x-api-key': CLASS_KEY, 'x-group-name': 'team-3' }), { group: 'team-3' });
  assert.deepEqual(call({ 'x-class-key': CLASS_KEY }, 'http://x/api/mcp?agent=scout&group=team-3'), { group: 'team-3' });
  const noKey = call({ 'x-group': 'team-3' });
  assert.equal(noKey.status, 401);
  assert.match(noKey.error, /"Authorization: Bearer <class key>" and "X-Group: <your group name>"/);
  const noGroup = call({ authorization: `Bearer ${CLASS_KEY}` });
  assert.equal(noGroup.status, 400);
  assert.match(noGroup.error, /^Missing group name\. Send two headers/);
  assert.equal(call({}, `http://x/api/mcp?key=${CLASS_KEY}&group=team-3`).status, 401, 'never the key in the address');
});

test('the Meal Planner is told the defaults it gets: every recipe, up to 500', async () => {
  const { handle } = await import('../api/mcp.js');
  const { as } = await import('./helpers.js');
  const list = async (agent) => {
    const res = await handle(new Request(`http://x/api/mcp?agent=${agent}`, {
      method: 'POST',
      headers: { ...as('team-1'), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }));
    return (await res.json()).result.tools.find((t) => t.name === 'list_recipes')?.inputSchema.properties;
  };
  const planner = await list('planner');
  assert.deepEqual([planner.status.default, planner.limit.default], ['all', 500]);
  const plain = await list('');
  assert.deepEqual([plain.status.default, plain.limit.default], ['new', 50]);
});

test('the coordinator says back which group it knows the app as, when it connects', async () => {
  const { handle } = await import('../api/mcp.js');
  const { as } = await import('./helpers.js');
  const rpc = async (method, params) => (await (await handle(new Request('http://x/api/mcp?agent=scout', {
    method: 'POST',
    headers: { ...as('Team Green'), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))).json()).result;
  const hello = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'app', version: '1' } });
  assert.match(hello.instructions, /^You're connected as group "team-green"\./);
  const contract = JSON.parse((await rpc('tools/call', { name: 'get_contract', arguments: {} })).content[0].text);
  assert.equal(contract.your_group, 'team-green');
  const { tools } = await rpc('tools/list', {});
  assert.match(tools.find((t) => t.name === 'get_contract').description, /^You're connected as group "team-green"\. Call this first\./);
  const res = await handle(new Request('http://x/api/mcp?agent=planner', {
    method: 'POST',
    headers: { ...as('Team Green'), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }));
  assert.equal(res.headers.get('x-coordinator-group'), 'team-green');
  assert.ok((await res.json()).result.tools.length);
});
