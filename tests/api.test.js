// End-to-end tests against a real Postgres: the MCP tools through a real MCP
// client, and the REST API, checking both follow the same rules.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handle } from '../api/mcp.js';
import * as rest from '../api/recipes.js';
import { GET as health } from '../api/health.js';
import { KEYS, recipe, freshDatabase, closeDatabase, skipWithoutDb } from './helpers.js';

let db;
before(async () => { if (!skipWithoutDb) process.env.POSTGRES_URL = process.env.TEST_DATABASE_URL; });
beforeEach(async () => { if (!skipWithoutDb) db = await freshDatabase(); });
after(closeDatabase);

async function mcp(group = 'team-1') {
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/api/mcp'), {
    fetch: (url, init) => handle(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${KEYS[group]}` } },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
const out = (res) => JSON.parse(res.content[0].text);

function call(method, path, { group, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (group) headers.authorization = `Bearer ${KEYS[group]}`;
  // Mirror vercel.json's rewrite for the "processed" route.
  const m = path.match(/^\/api\/recipes\/([^/]+)\/processed$/);
  const url = m ? `http://x/api/recipes?id=${m[1]}&action=processed` : `http://x${path}`;
  const request = new Request(url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return rest[method](request).then(async (res) => ({ status: res.status, body: await res.json() }));
}

test('MCP publishes exactly the three tools, with their input formats', { skip: skipWithoutDb }, async () => {
  const client = await mcp();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['list_recipes', 'mark_processed', 'save_recipe']);
  const save = tools.find((t) => t.name === 'save_recipe');
  assert.equal(save.inputSchema.additionalProperties, false);
  assert.ok(save.inputSchema.required.includes('why_chosen'));
});

test('save_recipe stores under the caller’s group and rejects duplicates and incomplete recipes', { skip: skipWithoutDb }, async () => {
  const client = await mcp('team-2');
  const r = recipe({ meal_id: '52772' });
  const saved = await client.callTool({ name: 'save_recipe', arguments: r });
  assert.ok(!saved.isError, saved.content[0].text);
  const { rows } = await db.query('select group_name, status, ingredients from recipes');
  assert.deepEqual([rows[0].group_name, rows[0].status, rows[0].ingredients.length], ['team-2', 'new', 2]);

  const dup = await client.callTool({ name: 'save_recipe', arguments: r });
  assert.equal(dup.isError, true);
  assert.equal(dup.content[0].text, 'Rejected:\n- your group already saved meal_id "52772" for the theme "cheap weeknight vegetarian dinners"');

  // A different group may save the same recipe.
  const other = await (await mcp('team-1')).callTool({ name: 'save_recipe', arguments: r });
  assert.ok(!other.isError);

  const bad = await client.callTool({ name: 'save_recipe', arguments: recipe({ why_chosen: ' ', est_servings: 0 }) });
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].text, 'Rejected:\n- est_servings must be at least 1\n- why_chosen is empty');

  const log = await db.query("select group_name, channel, ok, detail from activity where action = 'save_recipe' order by id");
  assert.deepEqual(log.rows.map((l) => [l.group_name, l.channel, l.ok]), [
    ['team-2', 'mcp', true], ['team-2', 'mcp', false], ['team-1', 'mcp', true], ['team-2', 'mcp', false],
  ]);
});

test('list_recipes and mark_processed hand recipes over between groups', { skip: skipWithoutDb }, async () => {
  const scout = await mcp('team-1');
  const planner = await mcp('team-2');
  const ids = [];
  for (const theme of ['soups', 'soups', 'salads']) {
    ids.push(out(await scout.callTool({ name: 'save_recipe', arguments: recipe({ theme }) })).id);
  }

  const listed = out(await planner.callTool({ name: 'list_recipes', arguments: { theme: 'soups' } }));
  assert.equal(listed.count, 2);
  assert.ok(listed.recipes.every((r) => r.group === 'team-1' && r.status === 'new' && r.ingredients[0].raw));

  const marked = out(await planner.callTool({ name: 'mark_processed', arguments: { recipe_id: ids[0] } }));
  assert.deepEqual(marked, { processed: true, id: ids[0] });
  const again = out(await planner.callTool({ name: 'mark_processed', arguments: { recipe_id: ids[0] } }));
  assert.match(again.note, /already processed by team-2/);

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

test('REST follows the same rules with the same reasons', { skip: skipWithoutDb }, async () => {
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

test('health reports groups and database state without showing keys', { skip: skipWithoutDb }, async () => {
  const res = await health();
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { ok: true, database: 'ready', groups: ['team-1', 'team-2'], problems: [] });
  assert.doesNotMatch(text, /key-for/);

  await db.query('drop table recipes cascade');
  const missing = await (await health()).json();
  assert.equal(missing.database, 'no tables');
  const list = await call('GET', '/api/recipes');
  assert.equal(list.status, 503);
  assert.match(list.body.errors[0], /db:setup/);
});

test('schema.sql upgrades a database made by the earlier version', { skip: skipWithoutDb }, async () => {
  await db.query('drop table recipes cascade');
  await db.query(`create table recipes (
    id uuid primary key default gen_random_uuid(), theme text not null, meal_id text not null, name text not null,
    category text, cuisine text, ingredients jsonb not null, instructions text not null, est_minutes int, est_servings int,
    image_url text, source_url text, why_chosen text not null, status text not null default 'new',
    created_by text not null default 'recipe-scout', created_at timestamptz not null default now(),
    processed_at timestamptz, processed_by text, unique (theme, meal_id))`);
  await db.query(`insert into recipes (theme, meal_id, name, ingredients, instructions, why_chosen)
    values ('soups', '1', 'Old soup', '[{"name":"x","amount":1,"unit":"g","raw":"1 g x"}]', 'Boil everything for twenty minutes.', 'old')`);
  const { readFile } = await import('node:fs/promises');
  await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));

  const client = await mcp('team-1');
  const saved = await client.callTool({ name: 'save_recipe', arguments: recipe({ theme: 'soups', meal_id: '1' }) });
  assert.ok(!saved.isError, saved.content[0].text);
  const all = out(await client.callTool({ name: 'list_recipes', arguments: { status: 'all' } }));
  assert.deepEqual(all.recipes.map((r) => r.group).sort(), ['team-1', 'unassigned']);
});
