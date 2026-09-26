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
import { setPricerForTests, runQueue } from '../lib/pricer.js';
import { resetKroger } from '../lib/kroger.js';
import { BACKENDS, as, recipe, closeDatabase } from './helpers.js';

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
    });

  });
}
