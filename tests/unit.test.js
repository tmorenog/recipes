// Tests that need no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCaller, normalizeGroup } from '../lib/auth.js';
import { recipeSchema, reasons } from '../lib/recipes.js';
import { poolConfig } from '../lib/db.js';
import { recipe } from './helpers.js';
import { handle } from '../api/mcp.js';
import { POST } from '../api/recipes.js';

const why = (input) => reasons(recipeSchema.safeParse(input).error, input);

test('callers need the class key; the group comes from X-Group', () => {
  const req = (headers) => new Request('http://x', { headers });
  const key = { authorization: 'Bearer class-key-for-tests' };
  assert.deepEqual(checkCaller(req({ ...key, 'x-group': 'team-2' })), { group: 'team-2' });
  assert.deepEqual(checkCaller(req({ authorization: 'bearer class-key-for-tests', 'x-group': 'Blue Team' })), { group: 'blue-team' });
  assert.equal(checkCaller(req({ ...key })).status, 400);
  assert.deepEqual(checkCaller(req({ ...key }), { needGroup: false }), { group: null });
  assert.equal(checkCaller(req({ authorization: 'Bearer nope', 'x-group': 'team-2' })).status, 401);
  assert.equal(checkCaller(req({ 'x-group': 'team-2' })).status, 401);
  assert.equal(normalizeGroup('a'.repeat(41)), null);
  assert.equal(normalizeGroup('<script>'), null);

  const saved = process.env.CLASS_KEY;
  delete process.env.CLASS_KEY;
  assert.equal(checkCaller(req({ ...key, 'x-group': 'team-2' })).status, 503);
  process.env.CLASS_KEY = saved;
});

test('rejection reasons are readable', () => {
  const r = recipe();
  delete r.instructions;
  assert.deepEqual(why({ ...r, why_chosen: '', est_servings: 0, calories: 5, image_url: 'ftp://x', ingredients: [] }), [
    'ingredients needs at least 1 item',
    'instructions is missing',
    'est_servings must be at least 1',
    'image_url must start with http:// or https://',
    'why_chosen is empty',
    'unknown field: calories',
  ]);
  assert.deepEqual(why(recipe({ ingredients: [{ name: 'egg', amount: -1, unit: null, raw: '1 egg', size: 'L' }], est_minutes: 2.5 })), [
    'ingredients.0.amount must be more than 0',
    'unknown field in ingredients.0: size',
    'est_minutes must be a whole number',
  ]);
  assert.deepEqual(why(recipe({ name: 42, instructions: 'too short' })), [
    'name must be a string',
    'instructions is too short (at least 20 characters)',
  ]);
});

test('hosted databases get TLS without certificate checks; local ones get none', () => {
  const hosted = poolConfig('postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x');
  assert.deepEqual(hosted.ssl, { rejectUnauthorized: false });
  assert.doesNotMatch(hosted.connectionString, /sslmode|supa=/);
  assert.equal(poolConfig('postgres://postgres@localhost:5432/db').ssl, false);
});

test('writes without the class key are refused before touching the database', async () => {
  const body = JSON.stringify(recipe());
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await POST(new Request('http://x/api/recipes', { method: 'POST', headers, body }))).status, 401);
  const mcp = await handle(new Request('http://x/api/mcp', { method: 'POST', headers: { ...headers, authorization: 'Bearer nope-nope-nope', 'x-group': 'team-1' }, body: '{}' }));
  assert.equal(mcp.status, 401);
  assert.match((await mcp.json()).error.message, /class key/);
});

test('the connection string is found with or without a prefix, preferring exact names', async () => {
  const { setting } = await import('../lib/env.js');
  const { databaseUrl } = await import('../lib/db.js');
  assert.equal(databaseUrl({ env: { STORAGE_DATABASE_URL: 'a' } }), 'a');
  assert.equal(setting(['POSTGRES_URL'], { STORAGE_POSTGRES_URL: 'a', POSTGRES_URL: 'b' }), 'b');
  assert.equal(databaseUrl({ env: { POSTGRES_URL: 'p', X_POSTGRES_URL_NON_POOLING: 'd' }, direct: true }), 'd');
  assert.equal(databaseUrl({ env: { SUPABASE_URL: 'https://x.supabase.co' } }), null);
});

test('health explains a missing database and keys, without showing values', async () => {
  const { GET } = await import('../api/health.js');
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/POSTGRES|DATABASE_URL|CLASS_KEY|ADMIN_KEY|KROGER/.test(k)) delete process.env[k];
  try {
    const res = await GET();
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.deepEqual([body.database, body.class_key, body.admin_key, body.kroger], ['not connected', false, false, false]);
    assert.match(body.problems.join(' '), /CLASS_KEY is not set.*create a Neon/);
    assert.equal(body.warnings.length, 2);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('MCP works with plain fetch: ?agent=scout shows only the Scout’s tools, and get_expectations explains the format', async () => {
  const { CLASS_KEY } = await import('./helpers.js');
  const rpc = (query, method, params) =>
    handle(new Request(`http://x/api/mcp${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CLASS_KEY}`, 'x-group': 'team-1', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params && { params }) }),
    }));

  const list = await rpc('?agent=scout', 'tools/list');
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).result.tools.map((t) => t.name), ['get_expectations', 'save_recipe', 'list_recipes']);

  const brief = JSON.parse((await (await rpc('?agent=scout', 'tools/call', { name: 'get_expectations', arguments: {} })).json()).result.content[0].text);
  assert.equal(brief.agent, 'Recipe Scout');
  assert.deepEqual(Object.keys(brief.recipe_format), Object.keys(recipeSchema.shape));
  assert.match(brief.recipe_format.why_chosen, /^required/);
  assert.match(brief.recipe_format.image_url, /^optional/);
  assert.ok(recipeSchema.safeParse(brief.example).success, 'the example must pass the checks');

  const planner = await (await rpc('?agent=planner', 'tools/list')).json();
  assert.deepEqual(planner.result.tools.map((t) => t.name).sort(), [
    'find_kroger_stores', 'get_expectations', 'list_recipes', 'mark_processed', 'save_meal_plan', 'search_kroger_products',
  ]);
  const plannerBrief = JSON.parse((await (await rpc('', 'tools/call', { name: 'get_expectations', arguments: { agent: 'planner' } })).json()).result.content[0].text);
  assert.equal(plannerBrief.agent, 'Meal Planner');
  const { planSchema, mealSchema } = await import('../lib/plans.js');
  assert.deepEqual(Object.keys(plannerBrief.plan_format), Object.keys(planSchema.shape));
  assert.deepEqual(Object.keys(plannerBrief.meal_format), Object.keys(mealSchema.shape));
  assert.ok(plannerBrief.balance_rules.per_serving.length && plannerBrief.checks.length);

  assert.equal((await rpc('?agent=chef', 'tools/list')).status, 400);
});

test('an ingredient without a measure is accepted, since TheMealDB has some', () => {
  const r = recipe();
  r.ingredients.push({ name: 'salt', amount: null, unit: null, raw: '' }, { name: 'pepper', amount: null, unit: null, raw: null });
  assert.ok(recipeSchema.safeParse(r).success);
});
