// End-to-end tests: the MCP tools through a real MCP client, and the REST API,
// checking both follow the same rules. Run once per storage backend.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handle } from '../api/mcp.js';
import * as rest from '../api/recipes.js';
import { GET as health } from '../api/health.js';
import { BACKENDS, CLASS_KEY, as, recipe, mealPlan, closeDatabase } from './helpers.js';
import * as plansApi from '../api/meal-plans.js';
import { GET as activityApi } from '../api/activity.js';
import { GET as whoami } from '../api/whoami.js';

async function mcp(group = 'team-1') {
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/api/mcp'), {
    fetch: (url, init) => handle(new Request(url, init)),
    requestInit: { headers: as(group) },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
const out = (res) => JSON.parse(res.content[0].text);

function call(method, path, { group, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (group) Object.assign(headers, as(group));
  // Mirror vercel.json's rewrite for the "processed" route.
  const m = path.match(/^\/api\/recipes\/([^/]+)\/processed$/);
  const url = m ? `http://x/api/recipes?id=${m[1]}&action=processed` : `http://x${path}`;
  const request = new Request(url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return rest[method](request).then(async (res) => ({ status: res.status, body: await res.json() }));
}

after(closeDatabase);

for (const backend of BACKENDS) {
  describe(`with the ${backend.name} store`, { skip: backend.skip }, () => {
    let db;
    beforeEach(async () => { db = await backend.fresh(); });

    test('MCP publishes the tools, with their input formats', async () => {
      const client = await mcp();
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [
        'find_kroger_stores', 'get_expectations', 'list_recipes', 'mark_processed', 'save_meal_plan', 'save_recipe', 'search_kroger_products',
      ]);
      const save = tools.find((t) => t.name === 'save_recipe');
      assert.equal(save.inputSchema.additionalProperties, false);
      assert.ok(save.inputSchema.required.includes('why_chosen'));
    });

    test('save_recipe stores under the caller’s group and rejects duplicates and incomplete recipes', async () => {
      const client = await mcp('team-2');
      const r = recipe({ meal_id: '52772' });
      const saved = await client.callTool({ name: 'save_recipe', arguments: r });
      assert.ok(!saved.isError, saved.content[0].text);
      const [row] = await db.recipes();
      assert.deepEqual([row.group_name, row.status, row.ingredients.length], ['team-2', 'new', 2]);

      const dup = await client.callTool({ name: 'save_recipe', arguments: r });
      assert.equal(dup.isError, true);
      assert.equal(dup.content[0].text, 'Rejected:\n- your group already saved meal_id "52772" for the theme "cheap weeknight vegetarian dinners"');

      // A different group may save the same recipe.
      const other = await (await mcp('team-1')).callTool({ name: 'save_recipe', arguments: r });
      assert.ok(!other.isError);

      const bad = await client.callTool({ name: 'save_recipe', arguments: recipe({ why_chosen: ' ', est_servings: 0 }) });
      assert.equal(bad.isError, true);
      assert.equal(bad.content[0].text, 'Rejected:\n- est_servings must be at least 1\n- why_chosen is empty');

      const log = (await db.activity()).filter((l) => l.action === 'save_recipe');
      assert.deepEqual(log.map((l) => [l.group_name, l.channel, l.ok]), [
        ['team-2', 'mcp', true], ['team-2', 'mcp', false], ['team-1', 'mcp', true], ['team-2', 'mcp', false],
      ]);
    });

    test('list_recipes and mark_processed hand recipes over between groups', async () => {
      const scout = await mcp('team-1');
      const planner = await mcp('team-2');
      const ids = [];
      for (const theme of ['soups', 'soups', 'salads']) {
        ids.push(out(await scout.callTool({ name: 'save_recipe', arguments: recipe({ theme }) })).id);
      }

      const listed = out(await planner.callTool({ name: 'list_recipes', arguments: { theme: 'soups' } }));
      assert.equal(listed.count, 2);
      assert.ok(listed.recipes.every((r) => r.group === 'team-1' && r.status === 'new' && r.ingredients[0].raw));
      assert.equal(listed.recipes[0].id, ids[1], 'newest first');

      const marked = out(await planner.callTool({ name: 'mark_processed', arguments: { recipe_id: ids[0] } }));
      assert.deepEqual(marked, { processed: true, id: ids[0] });
      const again = out(await planner.callTool({ name: 'mark_processed', arguments: { recipe_id: ids[0] } }));
      assert.match(again.note, /already processed by team-2 at \d{4}-/);

      const ghost = await planner.callTool({ name: 'mark_processed', arguments: { recipe_id: randomUUID() } });
      assert.equal(ghost.isError, true);
      assert.match(ghost.content[0].text, /no recipe has the id/);
      const junk = await planner.callTool({ name: 'mark_processed', arguments: { recipe_id: 'soup' } });
      assert.match(junk.content[0].text, /"soup" is not a valid recipe id/);

      assert.equal(out(await planner.callTool({ name: 'list_recipes', arguments: {} })).count, 2);
      assert.equal(out(await planner.callTool({ name: 'list_recipes', arguments: { status: 'processed', group: 'team-1' } })).count, 1);
      const badList = await planner.callTool({ name: 'list_recipes', arguments: { status: 'eaten' } });
      assert.match(badList.content[0].text, /status must be one of: new, processed, all/);
    });

    test('REST follows the same rules with the same reasons', async () => {
      const r = recipe({ meal_id: 'rest-1' });
      assert.equal((await call('POST', '/api/recipes', { body: r })).status, 401);

      const created = await call('POST', '/api/recipes', { group: 'team-1', body: r });
      assert.equal(created.status, 201);
      assert.equal(created.body.recipe.group, 'team-1');

      const dup = await call('POST', '/api/recipes', { group: 'team-1', body: r });
      assert.equal(dup.status, 409);
      assert.deepEqual(dup.body.errors, ['your group already saved meal_id "rest-1" for the theme "cheap weeknight vegetarian dinners"']);

      const bad = await call('POST', '/api/recipes', { group: 'team-1', body: recipe({ why_chosen: ' ', est_servings: 0 }) });
      assert.equal(bad.status, 400);
      assert.deepEqual(bad.body.errors, ['est_servings must be at least 1', 'why_chosen is empty']);

      const notJson = await call('POST', '/api/recipes', { group: 'team-1', body: 'name=soup' });
      assert.equal(notJson.status, 400);

      // Reading needs no key.
      const list = await call('GET', '/api/recipes?status=all&group=team-1');
      assert.equal(list.status, 200);
      assert.equal(list.body.count, 1);
      assert.equal((await call('GET', '/api/recipes?limit=9999')).status, 400);

      const id = created.body.recipe.id;
      assert.equal((await call('POST', `/api/recipes/${id}/processed`)).status, 401);
      const done = await call('POST', `/api/recipes/${id}/processed`, { group: 'team-2' });
      assert.equal(done.status, 200);
      assert.deepEqual([done.body.already, done.body.recipe.processed_by], [false, 'team-2']);
      assert.equal((await call('POST', `/api/recipes/${id}/processed`, { group: 'team-2' })).body.already, true);
      assert.equal((await call('POST', `/api/recipes/${randomUUID()}/processed`, { group: 'team-2' })).status, 404);
      assert.equal((await call('GET', '/api/recipes')).body.count, 0);
    });

    test('health reports readiness, and missing tables are explained everywhere', async () => {
      const res = await health();
      const text = await res.text();
      assert.equal(res.status, 200, text);
      const body = JSON.parse(text);
      assert.deepEqual([body.ok, body.database, body.class_key], [true, 'ready', true]);
      assert.doesNotMatch(text, /class-key-for/);

      await db.dropRecipes();
      const missing = await (await health()).json();
      assert.equal(missing.database, 'no tables');
      const hint = /redeploy/;
      assert.match(missing.problems.join(' '), hint);

      const list = await call('GET', '/api/recipes');
      assert.equal(list.status, 503);
      assert.match(list.body.errors[0], hint);
      const tool = await (await mcp()).callTool({ name: 'list_recipes', arguments: {} });
      assert.equal(tool.isError, true);
      assert.match(tool.content[0].text, hint);
    });

    test('save_meal_plan checks the plan, saves it, and reminds the planner to mark recipes', async () => {
      const scout = await mcp('team-1');
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(out(await scout.callTool({ name: 'save_recipe', arguments: recipe() })).id);
      const planner = await mcp('team-2');

      const bad = mealPlan(ids);
      bad.total_cost_usd = 20;
      bad.meals[1].day = 1;
      bad.meals[2].cost_per_serving_usd = 5;
      bad.meals[4].recipe_id = randomUUID();
      bad.shopping_list[0].recipe_ids = [randomUUID()];
      const rejected = await planner.callTool({ name: 'save_meal_plan', arguments: bad });
      assert.equal(rejected.isError, true);
      for (const reason of [/adds up to 13.47/, /different day/, /cost_used_usd ÷ servings is 2.00/, /no recipe has the id/, /isn’t one of this plan’s meals/]) {
        assert.match(rejected.content[0].text, reason);
      }
      const four = mealPlan(ids.slice(0, 4));
      assert.match((await planner.callTool({ name: 'save_meal_plan', arguments: four })).content[0].text, /meals needs exactly 5 items/);
      assert.equal((await db.plans()).length, 0);

      const saved = out(await planner.callTool({ name: 'save_meal_plan', arguments: mealPlan(ids, { budget_usd: 10 }) }));
      assert.equal(saved.saved, true);
      assert.deepEqual(saved.warnings, ['over budget: 13.47 > 10']);
      assert.match(saved.next_step, /mark these recipes processed/);

      // REST: same rules, public reading.
      const post = (body, group = 'team-2') =>
        plansApi.POST(new Request('http://x/api/meal-plans', { method: 'POST', headers: { ...as(group), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      const restBad = await post({ ...mealPlan(ids), meals: [] });
      assert.equal(restBad.status, 400);
      assert.deepEqual((await restBad.json()).errors, ['meals needs exactly 5 items']);
      assert.equal((await post(mealPlan(ids))).status, 201);
      const listed = await (await plansApi.GET(new Request('http://x/api/meal-plans?group=team-2'))).json();
      assert.equal(listed.count, 2);
      assert.deepEqual([listed.plans[0].group, listed.plans[0].meals.length, typeof listed.plans[0].total_cost_usd], ['team-2', 5, 'number']);

      const log = await (await activityApi(new Request('http://x/api/activity?group=team-2&result=rejected'))).json();
      assert.deepEqual(log.activity.map((a) => [a.action, a.channel]), [['save_meal_plan', 'rest'], ['save_meal_plan', 'mcp'], ['save_meal_plan', 'mcp']]);
      assert.equal((await activityApi(new Request('http://x/api/activity?result=maybe'))).status, 400);
    });

    test('whoami checks the class key, with or without a group name', async () => {
      const ask = (headers) => whoami(new Request('http://x/api/whoami', { headers }));
      const ok = await ask({ authorization: `Bearer ${CLASS_KEY}` });
      assert.deepEqual([ok.status, await ok.json()], [200, { ok: true, group: null }]);
      assert.deepEqual(await (await ask({ ...as('Team 3') })).json(), { ok: true, group: 'team-3' });
      assert.equal((await ask({ authorization: 'Bearer wrong-key-123' })).status, 401);
    });

    test('writes need the group name, and names are normalised', async () => {
      const noGroup = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { authorization: `Bearer ${CLASS_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(recipe()) }));
      assert.equal(noGroup.status, 400);
      assert.match((await noGroup.json()).errors[0], /X-Group/);
      const bad = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as('team 3 / drop table'), 'content-type': 'application/json' }, body: JSON.stringify(recipe()) }));
      assert.equal(bad.status, 400);
      const good = await call('POST', '/api/recipes', { group: '  Team 3 ', body: recipe() });
      assert.equal(good.body.recipe.group, 'team-3');
    });

    if (backend.name === 'postgres') {
      test('schema.sql upgrades a database made by the earlier version', async () => {
        await db.pool.query('drop table recipes cascade');
        await db.pool.query(`create table recipes (
          id uuid primary key default gen_random_uuid(), theme text not null, meal_id text not null, name text not null,
          category text, cuisine text, ingredients jsonb not null, instructions text not null, est_minutes int, est_servings int,
          image_url text, source_url text, why_chosen text not null, status text not null default 'new',
          created_by text not null default 'recipe-scout', created_at timestamptz not null default now(),
          processed_at timestamptz, processed_by text, unique (theme, meal_id))`);
        await db.pool.query(`insert into recipes (theme, meal_id, name, ingredients, instructions, why_chosen)
          values ('soups', '1', 'Old soup', '[{"name":"x","amount":1,"unit":"g","raw":"1 g x"}]', 'Boil everything for twenty minutes.', 'old')`);
        await db.pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));

        const client = await mcp('team-1');
        const saved = await client.callTool({ name: 'save_recipe', arguments: recipe({ theme: 'soups', meal_id: '1' }) });
        assert.ok(!saved.isError, saved.content[0].text);
        const all = out(await client.callTool({ name: 'list_recipes', arguments: { status: 'all' } }));
        assert.deepEqual(all.recipes.map((r) => r.group).sort(), ['team-1', 'unassigned']);
      });
    }
  });
}
