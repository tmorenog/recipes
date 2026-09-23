// End-to-end tests: a real MCP client talks to the real endpoint handler,
// backed by the in-memory database.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handle } from '../api/mcp.js';
import { memoryDb } from './memory-db.js';

process.env.MCP_API_KEY = 'test-key';
let db;

async function connect({ key = 'test-key', caller = 'team-1' } = {}) {
  const fetch = (url, init) => handle(new Request(url, init), { getDb: () => db });
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch,
    requestInit: { headers: { authorization: `Bearer ${key}`, 'x-caller': caller } },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const body = (res) => JSON.parse(res.content[0].text);

function recipe(overrides = {}) {
  return {
    theme: 'cheap weeknight vegetarian dinners',
    meal_id: String(Math.floor(Math.random() * 1e9)),
    name: 'Chickpea curry',
    category: 'Vegetarian',
    cuisine: 'Indian',
    ingredients: [
      { name: 'chickpeas', amount: 400, unit: 'g', raw: '400g tin chickpeas' },
      { name: 'salt', amount: null, unit: null, raw: 'to taste' },
    ],
    instructions: 'Fry the onion, add spices, add chickpeas and simmer for 20 minutes.',
    est_minutes: 35,
    est_servings: 4,
    image_url: 'https://www.themealdb.com/images/media/meals/x.jpg',
    source_url: null,
    why_chosen: 'Cheap, fast and meat-free.',
    ...overrides,
  };
}

async function addFive(client) {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(body(await client.callTool({ name: 'save_recipe', arguments: recipe() })).id);
  return ids;
}

function plan(ids, overrides = {}) {
  const meals = ids.map((recipe_id, i) => ({
    day: i + 1,
    recipe_id,
    servings: 4,
    cost_used_usd: 8,
    cost_per_serving_usd: 2,
    nutrition_per_serving: { calories: 550, protein_g: 25, fiber_g: 9, sodium_mg: 700 },
  }));
  return {
    planner: 'meal-planner-team-1',
    summary: 'Five balanced vegetarian dinners under budget.',
    budget_usd: 60,
    store_id: '01400943',
    total_cost_usd: 13.47,
    meals,
    shopping_list: [
      { item: 'chickpeas', kroger_product_id: '0001111', size: '15 oz', quantity: 3, unit_price_usd: 1.29, recipe_ids: [ids[0], ids[1]] },
      { item: 'yellow onions', size: '3 lb bag', quantity: 2, unit_price_usd: 4.8, recipe_ids: ids },
    ],
    rule_checks: [{ rule: 'at least 20 g protein per serving', passed: true }],
    ...overrides,
  };
}

beforeEach(() => {
  db = memoryDb();
});

test('rejects requests without the right API key', async () => {
  const init = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' };
  assert.equal((await handle(new Request('http://t/mcp', init), { getDb: () => db })).status, 401);
  init.headers.authorization = 'Bearer wrong-key!';
  assert.equal((await handle(new Request('http://t/mcp', init), { getDb: () => db })).status, 401);
  await assert.rejects(connect({ key: 'nope' }));
});

test('publishes the four tools', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['list_recipes', 'mark_processed', 'save_meal_plan', 'save_recipe']);
  const add = tools.find((t) => t.name === 'save_recipe');
  assert.equal(add.inputSchema.additionalProperties, false);
  assert.ok(add.inputSchema.required.includes('why_chosen'));
});

test('save_recipe stores a valid recipe and rejects duplicates', async () => {
  const client = await connect();
  const r = recipe({ meal_id: '52772' });
  const saved = await client.callTool({ name: 'save_recipe', arguments: r });
  assert.ok(!saved.isError);
  assert.equal(body(saved).status, 'new');
  assert.equal(db.recipes[0].created_by, 'team-1');

  const dup = await client.callTool({ name: 'save_recipe', arguments: r });
  assert.equal(dup.isError, true);
  assert.match(dup.content[0].text, /already saved/);
  assert.equal(db.recipes.length, 1);
});

test('save_recipe rejects malformed recipes, with reasons, and logs them', async () => {
  const client = await connect();
  const cases = [
    [recipe({ why_chosen: '' }), /why_chosen/],
    [recipe({ ingredients: [] }), /ingredients/],
    [recipe({ ingredients: [{ name: 'egg', amount: -2, unit: null, raw: '2 eggs' }] }), /amount/],
    [recipe({ est_servings: 0 }), /est_servings/],
    [recipe({ image_url: 'javascript:alert(1)' }), /image_url/],
    [recipe({ calories: 400 }), /calories|unrecognized/i],
    [(({ instructions, ...rest }) => rest)(recipe()), /instructions/],
  ];
  for (const [args, reason] of cases) {
    const res = await client.callTool({ name: 'save_recipe', arguments: args });
    assert.equal(res.isError, true, `expected rejection for ${reason}`);
    assert.match(res.content[0].text, reason);
  }
  assert.equal(db.recipes.length, 0);
  assert.equal(db.calls.filter((c) => c.tool === 'save_recipe' && !c.ok).length, cases.length);
});

test('list_recipes returns new recipes by default', async () => {
  const client = await connect();
  const ids = await addFive(client);
  db.recipes[0].status = 'processed';
  const res = body(await client.callTool({ name: 'list_recipes', arguments: {} }));
  assert.equal(res.count, 4);
  assert.ok(res.recipes.every((r) => r.status === 'new' && r.ingredients.length && r.why_chosen));
  const all = body(await client.callTool({ name: 'list_recipes', arguments: { status: 'all', limit: 2 } }));
  assert.equal(all.count, 2);
  assert.equal(all.recipes[0].id, ids[0]);
});

test('mark_processed reports updated, already processed and unknown ids', async () => {
  const client = await connect();
  const ids = await addFive(client);
  const first = await client.callTool({ name: 'mark_processed', arguments: { recipe_ids: ids.slice(0, 2), processed_by: 'planner-1' } });
  assert.ok(!first.isError);
  assert.deepEqual(body(first).updated, ids.slice(0, 2));
  assert.equal(db.recipes[0].processed_by, 'planner-1');

  const ghost = randomUUID();
  const second = await client.callTool({ name: 'mark_processed', arguments: { recipe_ids: [ids[1], ids[2], ghost] } });
  assert.equal(second.isError, true);
  assert.deepEqual(body(second), { updated: [ids[2]], already_processed: [ids[1]], not_found: [ghost] });

  const bad = await client.callTool({ name: 'mark_processed', arguments: { recipe_ids: ['not-a-uuid'] } });
  assert.equal(bad.isError, true);

  const left = body(await client.callTool({ name: 'list_recipes', arguments: {} }));
  assert.equal(left.count, 2);
});

test('save_meal_plan stores a valid plan and reminds the planner to mark recipes', async () => {
  const client = await connect();
  const ids = await addFive(client);
  const res = await client.callTool({ name: 'save_meal_plan', arguments: plan(ids) });
  assert.ok(!res.isError, res.content[0].text);
  const out = body(res);
  assert.equal(out.saved, true);
  assert.deepEqual(out.warnings, []);
  assert.match(out.next_step, /mark_processed/);
  assert.equal(db.plans.length, 1);
});

test('save_meal_plan rejects inconsistent plans with every reason', async () => {
  const client = await connect();
  const ids = await addFive(client);
  const p = plan(ids);
  p.total_cost_usd = 20;
  p.meals[1].day = 1;
  p.meals[2].cost_per_serving_usd = 5;
  p.meals[4].recipe_id = randomUUID();
  p.shopping_list[0].recipe_ids = [randomUUID()];
  const res = await client.callTool({ name: 'save_meal_plan', arguments: p });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  for (const reason of [/adds up to 13.47/, /different day/, /cost_used_usd \/ servings is 2.00/, /does not exist/, /not one of this plan's meals/]) {
    assert.match(text, reason);
  }
  assert.equal(db.plans.length, 0);
});

test('save_meal_plan needs exactly 5 meals and flags going over budget', async () => {
  const client = await connect();
  const ids = await addFive(client);
  const four = plan(ids);
  four.meals = four.meals.slice(0, 4);
  const res = await client.callTool({ name: 'save_meal_plan', arguments: four });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /meals/);

  const over = await client.callTool({ name: 'save_meal_plan', arguments: plan(ids, { budget_usd: 10 }) });
  assert.ok(!over.isError);
  assert.deepEqual(body(over).warnings, ['over budget: 13.47 > 10']);
});
