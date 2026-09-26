// Hardening from the reviews: migrations that run once, the pricing pause,
// per-minute limits that hold under load, request sizes, and readable errors.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as adminApi from '../api/admin.js';
import * as rest from '../api/recipes.js';
import * as plansApi from '../api/meal-plans.js';
import * as krogerApi from '../api/kroger.js';
import { POST as mcpPost } from '../api/mcp.js';
import { getStore } from '../lib/store/index.js';
import { saveSettings } from '../lib/settings.js';
import { setPricerForTests, runQueue, startTest } from '../lib/pricer.js';
import * as pricerApi from '../api/pricer.js';
import { resetKroger } from '../lib/kroger.js';
import { BACKENDS, as, recipe, mealPlan, markPriced, closeDatabase } from './helpers.js';

const ADMIN_KEY = 'admin-key-for-tests';
process.env.ADMIN_KEY = ADMIN_KEY;

const schema = () => readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const getJson = async (res) => ({ status: res.status, body: await res.json() });
const admin = (method, action, body) => adminApi[method](new Request(`http://x/api/admin?action=${action}`, {
  method,
  headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
})).then(getJson);
const saveRest = (group, body) => rest.POST(new Request('http://x/api/recipes', {
  method: 'POST', headers: { ...as(group), 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));
let rpcId = 0;
const mcpRaw = (group, body, agent) => mcpPost(new Request(`http://x/api/mcp${agent ? `?agent=${agent}` : ''}`, {
  method: 'POST',
  headers: { ...as(group), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}));
const toolCall = (name, args) => ({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });

// Kroger, faked: one store, one product.
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
async function fakeKroger(url) {
  const u = String(url);
  if (u.includes('/connect/oauth2/token')) return reply({ access_token: 't', expires_in: 1800 });
  if (u.includes('/locations')) return reply({ data: [{ locationId: '01400943', name: 'Kroger Test', address: {} }] });
  if (u.includes('/products')) return reply({ data: [{ productId: '0001', description: 'Garbanzo Beans', items: [{ size: '15.5 oz', price: { regular: 0.99 } }], images: [] }] });
  throw new Error(`unexpected fetch ${u}`);
}

after(async () => {
  setPricerForTests({ model: null, fetch: null, auto: true });
  await closeDatabase();
});

for (const backend of BACKENDS) {
  describe(`hardening with the ${backend.name} store`, { skip: backend.skip }, () => {
    let db;
    beforeEach(async () => {
      db = await backend.fresh();
      setPricerForTests({ model: null, fetch: null, auto: false });
    });

    test('fixes to edited prompts run once: redeploys keep the instructor’s later edits', async () => {
      const edits = [
        ['scout', 1, 'Find five recipes that fit the theme "15-minute lunches". Use COORDINATOR_KEY and get_expectations.'],
        ['planner', 10, 'My own version for the Scouting Agents.'],
        ['planner', 11, 'Send the header followed by CLASS_KEY, and our group name. Also call search_foods for each dinner and show me the result.'],
      ];
      for (const [agent, step, text] of edits) await db.pool.query('insert into prompt_overrides (agent, step, text) values ($1, $2, $3)', [agent, step, text]);
      await db.pool.query("insert into pricer_config (key, value) values ('prompt', 'You are the Pricer, an agent that runs on the class''s recipe coordinator. Price it.')");
      const snapshot = async () => JSON.stringify((await db.pool.query(
        "select agent, step, text from prompt_overrides union all select 'pricer', 0, value from pricer_config order by 1, 2",
      )).rows);
      const before = await snapshot();
      await db.pool.query(await schema());
      await db.pool.query(await schema());
      assert.equal(await snapshot(), before, 'a fresh database already had its one run');

      // A database from before the marker (every fix already ran on each deploy): its first run changes nothing either.
      await db.pool.query("delete from coordinator_settings where key = 'migration:prompt-text-fixes'");
      await db.pool.query(await schema());
      assert.equal(await snapshot(), before);
      assert.equal((await db.pool.query("select count(*)::int as n from coordinator_settings where key like 'migration:%'")).rows[0].n, 2);
    });

    test('paused pricing: restore and the sample database wait unpriced, and only the instructor’s request runs the queue', async () => {
      await saveSettings({ auto_pricing: false });
      assert.equal((await saveRest('team-1', recipe({ meal_id: '901' }))).status, 201);
      const backup = (await admin('GET', 'backup')).body;
      assert.equal((await admin('POST', 'restore', backup)).status, 200);
      const statuses = async () => (await db.pool.query('select distinct status from pricings')).rows.map((r) => r.status);
      assert.deepEqual(await statuses(), ['unpriced']);
      assert.equal((await admin('POST', 'load-sample', { confirm: 'SAMPLE', prices: false })).status, 200);
      assert.deepEqual(await statuses(), ['unpriced']);

      // A recipe waiting in the queue when the pause started is left alone by automatic runs.
      await db.pool.query("update pricings set status = 'pending' where meal_id = (select meal_id from pricings limit 1)");
      const lines = (await db.pool.query("select jsonb_array_length(r.ingredients) as n from recipes r join pricings p using (meal_id) where p.status = 'pending'")).rows[0].n;
      let turn = 0;
      const model = async () => {
        turn += 1;
        const content = turn === 1
          ? [{ type: 'tool_use', id: 's', name: 'search_kroger', input: { term: 'beans' } },
            ...Array.from({ length: lines }, (_, i) => ({ type: 'tool_use', id: `k${i}`, name: 'skip_ingredient', input: { line: i + 1, reason: 'test' } }))]
          : [{ type: 'tool_use', id: 'f', name: 'finish', input: { people: 4, summary: 'Nothing to buy.' } }];
        return { stop_reason: 'tool_use', content };
      };
      process.env.KROGER_CLIENT_ID = 'test-id';
      process.env.KROGER_CLIENT_SECRET = 'test-secret';
      resetKroger();
      setPricerForTests({ model, fetch: fakeKroger, auto: false });
      assert.equal(await runQueue(), 0, 'paused: automatic runs price nothing');
      assert.equal(await runQueue({ requested: true }), 1, 'the instructor’s request still prices');
      assert.equal((await db.pool.query("select count(*)::int as n from rate_hits where kind = 'kroger'")).rows[0].n, 0, 'the Pricer’s own Kroger searches are not limited');
    });

    test('the per-minute save limits hold for saves sent at the same moment, per group and for the class', async () => {
      await saveSettings({ max_saves_per_minute: 3, max_recipes_per_group: 0 });
      const burst = await Promise.all(Array.from({ length: 8 }, () => saveRest('team-1', recipe())));
      assert.deepEqual(burst.map((r) => r.status).sort(), [201, 201, 201, 429, 429, 429, 429, 429]);

      await db.pool.query('delete from rate_hits'); // a minute later
      await saveSettings({ max_saves_per_minute: 0, max_class_saves_per_minute: 4 });
      const classwide = await Promise.all(Array.from({ length: 6 }, (_, i) => saveRest(`team-${i + 2}`, recipe())));
      const statuses = classwide.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 201, 201, 201, 429, 429]);
      const refused = await classwide.find((r) => r.status === 429).json();
      assert.match(refused.errors[0], /too many save attempts: the whole class can make at most 4 a minute/);
    });

    test('Kroger look-ups with the class key are limited per group and for the class, over REST and MCP', async () => {
      process.env.KROGER_CLIENT_ID = 'test-id';
      process.env.KROGER_CLIENT_SECRET = 'test-secret';
      resetKroger();
      const realFetch = globalThis.fetch;
      globalThis.fetch = fakeKroger;
      try {
        await saveSettings({ max_kroger_per_minute: 2, max_class_kroger_per_minute: 3 });
        const stores = (group) => krogerApi.GET(new Request('http://x/api/kroger?what=stores&zip=45202', { headers: as(group) }));
        assert.equal((await stores('team-1')).status, 200);
        assert.equal((await stores('team-1')).status, 200);
        const third = await getJson(await stores('team-1'));
        assert.equal(third.status, 429);
        assert.match(third.body.errors[0], /too many Kroger look-ups: each group can make at most 2 a minute/);

        const search = await (await mcpRaw('team-2', toolCall('search_kroger_products', { term: 'beans', store_id: '01400943' }))).json();
        assert.equal(search.result.isError, undefined, JSON.stringify(search));
        const over = await (await mcpRaw('team-3', toolCall('find_kroger_stores', { zip: '45202' }))).json();
        assert.equal(over.result.isError, true);
        assert.match(over.result.content[0].text, /whole class can make at most 3 a minute together/);
      } finally {
        globalThis.fetch = realFetch;
        resetKroger();
      }
    });

    test('the activity log keeps a shortened copy of large requests, and only the newest entries', async () => {
      const big = recipe({ instructions: 'Stir. '.repeat(3000) });
      assert.equal((await saveRest('team-1', big)).status, 201);
      const [row] = (await db.pool.query("select input from activity where action = 'save_recipe'")).rows;
      assert.ok(typeof row.input.truncated === 'string', 'kept as valid JSON, marked truncated');
      assert.ok(JSON.stringify(row.input).length < 4500);

      await db.pool.query("insert into activity (group_name, channel, action, ok) select 'x', 'rest', 'filler', true from generate_series(1, 5010)");
      await getStore().logActivity({ group_name: 'team-1', channel: 'rest', action: 'save_recipe', ok: false, detail: 'last', input: null });
      assert.equal((await db.pool.query('select count(*)::int as n from activity')).rows[0].n, 5000);
      assert.equal((await db.pool.query('select detail from activity order by id desc limit 1')).rows[0].detail, 'last');
    });

    test('request bodies over the size limit are refused before they are read', async () => {
      const huge = JSON.stringify({ ...recipe(), why_chosen: 'x'.repeat(300 * 1024) });
      const r = await getJson(await saveRest('team-1', huge));
      assert.equal(r.status, 413);
      assert.match(r.body.errors[0], /too large: at most 256 KB/);
      const plan = await plansApi.POST(new Request('http://x/api/meal-plans', { method: 'POST', headers: { ...as('team-1'), 'content-length': String(10 * 1024 * 1024) }, body: '{}' }));
      assert.equal(plan.status, 413, 'a declared size is enough');
      // A backup may be large.
      const restore = await admin('POST', 'restore', JSON.stringify({ format: 'something else', padding: 'x'.repeat(1024 * 1024) }));
      assert.equal(restore.status, 400);
      assert.match(restore.body.errors[0], /isn’t a Meal Squad backup/);
      assert.equal((await db.pool.query('select count(*)::int as n from activity')).rows[0].n, 0, 'nothing was logged');
    });

    test('MCP: tool arguments sent as a string or null, big batches, big bodies and broken JSON get readable answers', async () => {
      const asText = await (await mcpRaw('team-1', toolCall('get_contract', JSON.stringify({})), 'scout')).json();
      assert.equal(asText.result.isError, undefined, 'arguments sent as a JSON string are read');
      const asNull = await (await mcpRaw('team-1', toolCall('get_contract', null), 'scout')).json();
      assert.equal(asNull.result.isError, undefined, 'null is the same as no arguments');
      const bad = await (await mcpRaw('team-1', toolCall('save_recipe', '{not json'), 'scout')).json();
      assert.deepEqual([bad.result.isError, bad.result.content[0].text], [true, 'Rejected:\n- arguments must be a JSON object, e.g. {"theme": "…"}']);
      const number = await (await mcpRaw('team-1', toolCall('save_recipe', 5), 'scout')).json();
      assert.equal(number.result.isError, true);

      // A batch: answers made here and the SDK's come back together.
      const both = await (await mcpRaw('team-1', [toolCall('save_recipe', '[]'), { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }], 'scout')).json();
      assert.equal(both.length, 2);
      assert.ok(both.some((m) => m.result?.isError) && both.some((m) => m.result?.tools));

      const many = await mcpRaw('team-1', Array.from({ length: 11 }, () => ({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' })));
      assert.equal(many.status, 400);
      assert.match((await many.json()).error.message, /at most 10 requests/);

      const large = await mcpRaw('team-1', toolCall('save_recipe', { ...recipe(), why_chosen: 'x'.repeat(300 * 1024) }), 'scout');
      assert.equal(large.status, 413);
      assert.match((await large.json()).error.message, /too large: at most 256 KB/);

      const deep = await mcpRaw('team-1', `${'['.repeat(100_000)}${']'.repeat(100_000)}`);
      assert.ok([200, 400].includes(deep.status), `answered ${deep.status}`);
      const answer = await deep.json();
      assert.ok(answer.error?.message, 'a readable JSON-RPC error');
      assert.doesNotMatch(answer.error.message, /invalid_type|expected/);
    });

    test('backup agent runs cut off by the server are reported as failed, not running forever', async () => {
      const { rows: [old] } = await db.pool.query(
        "insert into backup_runs (agent, group_name, input, created_at) values ('scout', 'team-1', '{}', now() - interval '10 minutes') returning id",
      );
      await db.pool.query("insert into backup_runs (agent, group_name, input) values ('planner', 'team-1', '{}')");
      const store = getStore();
      const one = await store.getBackupRun(old.id);
      assert.deepEqual([one.status, one.outcome], ['failed', 'Run failed']);
      assert.match(one.summary, /took too long/);
      assert.equal((await store.latestAgentRun('scout')).status, 'failed');
      const runs = await store.listBackupRuns();
      assert.deepEqual(runs.map((r) => [r.agent, r.status]).sort(), [['planner', 'running'], ['scout', 'failed']]);
    });

    test('an admin edit and the Pricer’s price write lock in the same order, so they can’t deadlock', { timeout: 15_000 }, async () => {
      const saved = await (await saveRest('team-1', recipe())).json();
      const { meal_id: mealId, id } = saved.recipe;
      const pricer = await db.pool.connect();
      try {
        // The Pricer's write: its pricing row first, then (in sync_recipe_price) the recipe.
        await pricer.query('begin');
        await pricer.query('select 1 from pricings where meal_id = $1 for update', [mealId]);
        const edit = admin('POST', `recipe&id=${id}`, { ingredients: [{ name: 'lentils', amount: 1, unit: 'cup', raw: '1 cup' }] });
        await new Promise((r) => setTimeout(r, 300)); // the edit is waiting now
        await pricer.query('update recipes set price_status = price_status where meal_id = $1', [mealId]);
        await pricer.query('commit');
        const res = await edit;
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.repriced, true);
      } finally {
        await pricer.query('rollback').catch(() => {});
        pricer.release();
      }
    });

    test('sample prices don’t count toward the Pricer’s hourly limit', async () => {
      assert.equal((await admin('POST', 'load-sample', { confirm: 'SAMPLE', prices: true })).status, 200);
      assert.equal((await db.pool.query("select count(*)::int as n from pricings where status = 'priced'")).rows[0].n, 20);
      assert.equal(await getStore().pricingsFinishedSince(new Date(Date.now() - 3_600_000).toISOString()), 0);
    });

    test('a run that lost its claim adds no steps to the next run’s trace, and the claim token stays private', async () => {
      await saveRest('team-1', recipe({ meal_id: '4242' }));
      const store = getStore();
      const first = await store.claimPricing({ maxActive: 2 });
      await store.addPricerStep({ meal_id: '4242', attempt: 1, kind: 'thought', text: 'first run', token: first.claim_token });
      await store.resetPricing('4242'); // Start over
      const second = await store.claimPricing({ maxActive: 2 });
      await store.addPricerStep({ meal_id: '4242', attempt: 1, kind: 'thought', text: 'old run, still going', token: first.claim_token });
      await store.addPricerStep({ meal_id: '4242', attempt: 1, kind: 'thought', text: 'new run', token: second.claim_token });
      const { body } = await pricerApi.GET(new Request('http://x/api/pricer?meal_id=4242')).then(getJson);
      assert.deepEqual(body.steps.map((s) => s.text), ['new run']);
      assert.equal('claim_token' in body, false);
      assert.equal('messages' in body, false);
    });

    test('backup and restore keep the class’s plan; older backups without it still restore', async () => {
      const ids = [];
      for (const cuisine of ['Indian', 'Italian', 'Thai', 'Mexican', 'Greek']) ids.push((await (await saveRest('team-1', recipe({ cuisine }))).json()).recipe.id);
      await markPriced(db.pool, ids);
      const plan = await (await plansApi.POST(new Request('http://x/api/meal-plans', { method: 'POST', headers: { ...as('team-1'), 'content-type': 'application/json' }, body: JSON.stringify(mealPlan(ids)) }))).json();
      await getStore().saveChoice({ plan_id: plan.plan.id, reason: 'The only plan, and it passes.', people: 50, cart: { people: 50, lines: [] }, total_usd: 12.5 });
      const backup = (await admin('GET', 'backup')).body;
      assert.equal(backup.choices.length, 1);
      assert.equal((await admin('POST', 'reset', { confirm: 'RESET' })).status, 200);
      assert.equal((await admin('POST', 'restore', backup)).status, 200);
      const [choice] = await getStore().listChoices();
      assert.deepEqual([choice.plan_id, choice.total_usd, choice.reason], [plan.plan.id, 12.5, 'The only plan, and it passes.']);

      const { choices, ...older } = backup;
      assert.equal((await admin('POST', 'restore', older)).status, 200);
      assert.equal((await getStore().listChoices()).length, 0);
    });

    test('a recipe is queued for the Pricer in the same transaction as its save, so a retry after a failure works', async () => {
      const r = recipe({ meal_id: '5151' });
      await db.pool.query('alter table pricings rename to pricings_away');
      try {
        assert.ok((await saveRest('team-1', r)).status >= 500);
      } finally {
        await db.pool.query('alter table pricings_away rename to pricings');
      }
      assert.equal((await db.pool.query('select count(*)::int as n from recipe_picks')).rows[0].n, 0, 'nothing was half saved');
      assert.equal((await saveRest('team-1', r)).status, 201);
      assert.equal((await db.pool.query("select status from pricings where meal_id = '5151'")).rows[0].status, 'pending');
    });

    test('the budget check uses the exact average, not the rounded one', async () => {
      const ids = [];
      for (const cuisine of ['Indian', 'Italian', 'Thai', 'Mexican', 'Greek']) ids.push((await (await saveRest('team-1', recipe({ cuisine }))).json()).recipe.id);
      await markPriced(db.pool, ids, (i) => [10.01, 10.01, 10, 10, 10][i]);
      const check = await (await plansApi.POST(new Request('http://x/api/meal-plans?check=true', { method: 'POST', headers: { ...as('team-1'), 'content-type': 'application/json' }, body: JSON.stringify(mealPlan(ids, { budget_usd: 10 })) }))).json();
      const budget = check.checks[0];
      assert.equal(budget.passed, false, '$10.004 a dinner is over a $10 budget');
      assert.match(budget.detail, /^\$10\.004 a dinner on average/);
    });

    test('a Pricer test that fails and can’t even record its failure doesn’t crash the server', async () => {
      process.env.KROGER_CLIENT_ID = 'test-id';
      process.env.KROGER_CLIENT_SECRET = 'test-secret';
      resetKroger();
      setPricerForTests({ model: async () => ({ stop_reason: 'end_turn', content: [] }), fetch: fakeKroger, auto: false });
      const store = getStore();
      const saved = { step: store.addPricerTestStep, update: store.updatePricerTest };
      store.addPricerTestStep = async () => { throw new Error('database gone'); };
      store.updatePricerTest = async () => { throw new Error('database gone'); };
      try {
        const res = await startTest({ ingredients: ['1 onion'] });
        assert.equal(res.ok, true, JSON.stringify(res.errors));
        await res.run; // settles; no unhandled rejection
      } finally {
        store.addPricerTestStep = saved.step;
        store.updatePricerTest = saved.update;
      }
    });
  });
}
