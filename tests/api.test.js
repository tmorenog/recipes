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
import { BACKENDS, CLASS_KEY, as, recipe, mealPlan, markPriced, closeDatabase } from './helpers.js';
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
        'check_meal_plan', 'find_kroger_stores', 'get_expectations', 'list_recipes', 'mark_processed', 'save_meal_plan', 'save_recipe', 'search_foods', 'search_kroger_products',
      ]);
      const save = tools.find((t) => t.name === 'save_recipe');
      assert.equal(save.inputSchema.additionalProperties, false);
      assert.ok(save.inputSchema.required.includes('why_chosen'));
    });

    test('save_recipe stores each recipe once, counts every group that picks it, and rejects repeats and incomplete recipes', async () => {
      const client = await mcp('team-2');
      const r = recipe({ meal_id: '52772' });
      const saved = await client.callTool({ name: 'save_recipe', arguments: r });
      assert.ok(!saved.isError, saved.content[0].text);
      const [row] = await db.recipes();
      assert.deepEqual([row.group_name, row.status, row.ingredients.length], ['team-2', 'new', 2]);

      const dup = await client.callTool({ name: 'save_recipe', arguments: r });
      assert.equal(dup.isError, true);
      assert.equal(dup.content[0].text, 'Rejected:\n- your group already picked meal_id "52772" for the theme "cheap weeknight vegetarian dinners": choose a different recipe');

      // Another group picking the same recipe adds a pick; the recipe is stored once.
      const other = out(await (await mcp('team-1')).callTool({ name: 'save_recipe', arguments: { ...r, theme: 'comfort food', why_chosen: 'Warming.' } }));
      assert.equal(other.new_recipe, false);
      assert.deepEqual(other.picked_by, ['team-2', 'team-1']);
      assert.match(other.note, /now picked by 2 groups/);
      assert.equal((await db.recipes()).length, 1);
      const listed = out(await client.callTool({ name: 'list_recipes', arguments: {} })).recipes[0];
      assert.equal(listed.pick_count, 2);
      assert.deepEqual(listed.picks.map((p) => [p.group, p.theme]), [['team-2', 'cheap weeknight vegetarian dinners'], ['team-1', 'comfort food']]);
      assert.equal(out(await client.callTool({ name: 'list_recipes', arguments: { group: 'team-1' } })).count, 1, 'filtering by group finds recipes it picked');
      assert.equal(out(await client.callTool({ name: 'list_recipes', arguments: { theme: 'comfort food' } })).count, 1);

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
      assert.deepEqual(dup.body.errors, ['your group already picked meal_id "rest-1" for the theme "cheap weeknight vegetarian dinners": choose a different recipe']);

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

    test('meal plans use priced recipes; the coordinator adds up the week and checks the rules', async () => {
      const scout = await mcp('team-1');
      const kinds = [['Indian', 'Vegetarian'], ['Mexican', 'Beef'], ['Italian', 'Chicken'], ['Thai', 'Chicken'], ['Mexican', 'Beef']];
      const ids = [];
      for (const [cuisine, category] of kinds) ids.push(out(await scout.callTool({ name: 'save_recipe', arguments: recipe({ cuisine, category }) })).id);
      const planner = await mcp('team-2');
      const tool = async (name, args) => planner.callTool({ name, arguments: args });

      // Not priced yet: the coordinator says so.
      const early = await tool('check_meal_plan', mealPlan(ids));
      assert.equal(early.isError, true);
      assert.match(early.content[0].text, /isn’t priced yet/);

      await markPriced(db.pool, ids, (i) => [1.5, 2.25, 3, 2, 4][i]);
      const priced = out(await tool('list_recipes', { priced: true }));
      assert.equal(priced.count, 5);
      assert.equal(priced.recipes.find((r) => r.id === ids[0]).pricing.cost_per_serving_usd, 1.5);

      const bad = mealPlan(ids);
      bad.meals[1].day = 'Monday';
      bad.meals[2].recipe_id = ids[0];
      bad.meals[4].recipe_id = randomUUID();
      const rejected = await tool('check_meal_plan', bad);
      assert.equal(rejected.isError, true);
      for (const reason of [/missing Tuesday/, /same recipe is used twice/, /no recipe has the id/]) assert.match(rejected.content[0].text, reason);
      assert.match((await tool('save_meal_plan', mealPlan(ids.slice(0, 4)))).content[0].text, /meals needs exactly 5 items/);
      assert.match((await tool('save_meal_plan', { ...mealPlan(ids), meals: mealPlan(ids).meals.map((m) => ({ ...m, day: 'Saturday' })) })).content[0].text, /day must be one of: Monday/);

      // A draft: the week costs 12.75 per person; the planner estimates Thursday is short of protein.
      const lowProtein = (plan) => { plan.meals[3].nutrition_per_serving.protein_g = 12; return plan; };
      const checked = out(await tool('check_meal_plan', lowProtein(mealPlan(ids, { budget_usd: 12 }))));
      assert.equal(checked.week_cost_per_person_usd, 12.75);
      assert.equal(checked.all_rules_passed, false);
      const failed = checked.checks.filter((c) => !c.passed);
      assert.deepEqual(failed.map((c) => c.rule), ['The week costs no more than the budget, per person', 'Every dinner has at least 20 g protein per serving']);
      assert.match(failed[1].detail, /Thursday/);
      assert.equal((await db.plans()).length, 0, 'checking saves nothing');

      const saved = out(await tool('save_meal_plan', lowProtein(mealPlan(ids, { budget_usd: 15 }))));
      assert.equal(saved.saved, true);
      assert.deepEqual(saved.checks.filter((c) => !c.passed).map((c) => c.rule), ['Every dinner has at least 20 g protein per serving']);
      const [row] = await db.plans();
      assert.equal(Number(row.total_cost_usd), 12.75);
      assert.deepEqual(row.meals.map((m) => [m.day, m.cost_per_serving_usd]), [['Monday', 1.5], ['Tuesday', 2.25], ['Wednesday', 3], ['Thursday', 2], ['Friday', 4]]);
      assert.equal(row.meals[0].nutrition_per_serving.calories, 550);

      // REST: the same rules, a check without saving, and public reading.
      const post = (body, query = '') =>
        plansApi.POST(new Request(`http://x/api/meal-plans${query}`, { method: 'POST', headers: { ...as('team-2'), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      const restBad = await post({ ...mealPlan(ids), meals: [] });
      assert.equal(restBad.status, 400);
      assert.deepEqual((await restBad.json()).errors, ['meals needs exactly 5 items']);
      const restCheck = await post(mealPlan(ids), '?check=true');
      assert.equal(restCheck.status, 200);
      assert.equal((await restCheck.json()).week_cost_per_person_usd, 12.75);
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
      test('schema.sql merges duplicate recipes saved by earlier versions, keeping every pick and pointing plans at the kept copy', async () => {
        await db.pool.query('drop index if exists recipes_meal_key');
        const ins = async (group, theme, at) => (await db.pool.query(
          `insert into recipes (group_name, theme, meal_id, name, ingredients, instructions, why_chosen, created_at)
           values ($1, $2, '777', 'Dal', '[{"name":"lentils","amount":1,"unit":"cup","raw":"1 cup"}]', 'Simmer the lentils for thirty minutes.', 'cheap', $3) returning id`,
          [group, theme, at])).rows[0].id;
        const first = await ins('team-1', 'soups', '2026-01-01');
        const copy = await ins('team-2', 'cheap eats', '2026-01-02');
        await db.pool.query('delete from recipe_picks');
        await db.pool.query(`insert into plans (group_name, summary, total_cost_usd, meals, shopping_list) values ('team-3', 'x', 1, $1, '[]')`,
          [JSON.stringify([{ day: 'Monday', recipe_id: copy }])]);
        await db.pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));

        const rows = await db.recipes();
        assert.deepEqual(rows.map((r) => r.id), [first]);
        const picks = (await db.pool.query('select group_name, theme from recipe_picks order by created_at')).rows;
        assert.deepEqual(picks.map((p) => [p.group_name, p.theme]), [['team-1', 'soups'], ['team-2', 'cheap eats']]);
        assert.equal((await db.plans())[0].meals[0].recipe_id, first);
      });

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
        assert.equal(all.count, 1, 'the same meal is one recipe');
        assert.deepEqual(all.recipes[0].picked_by.sort(), ['team-1', 'unassigned']);
      });
    }
  });
}
