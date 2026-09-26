// Admin endpoints: auth, editing, deleting, backup, restore and reset.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as adminApi from '../api/admin.js';
import * as rest from '../api/recipes.js';
import * as plansApi from '../api/meal-plans.js';
import { BACKENDS, as, recipe, mealPlan, markPriced, closeDatabase } from './helpers.js';

const ADMIN_KEY = 'admin-key-for-tests';
process.env.ADMIN_KEY = ADMIN_KEY;

function admin(method, action, { id, body, key = ADMIN_KEY } = {}) {
  const url = `http://x/api/admin?action=${action}${id ? `&id=${id}` : ''}`;
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const init = { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) };
  return adminApi[method](new Request(url, init)).then(async (res) => ({ status: res.status, headers: res.headers, body: await res.json() }));
}

async function saveRecipes(group, n, overrides = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const res = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as(group), 'content-type': 'application/json' }, body: JSON.stringify(recipe(overrides)) }));
    ids.push((await res.json()).recipe.id);
  }
  return ids;
}
const listAll = async () => (await (await rest.GET(new Request('http://x/api/recipes?status=all&limit=500'))).json()).recipes;

after(closeDatabase);

for (const backend of BACKENDS) {
  describe(`admin with the ${backend.name} store`, { skip: backend.skip }, () => {
    let db;
    beforeEach(async () => { db = await backend.fresh(); });

    test('needs the admin key, not the class key', async () => {
      assert.equal((await admin('GET', 'check', { key: null })).status, 401);
      assert.equal((await admin('GET', 'check', { key: process.env.CLASS_KEY })).status, 401);
      assert.equal((await admin('GET', 'check')).status, 200);
      delete process.env.ADMIN_KEY;
      try {
        const off = await admin('GET', 'check');
        assert.equal(off.status, 503);
        assert.match(off.body.errors[0], /ADMIN_KEY/);
      } finally {
        process.env.ADMIN_KEY = ADMIN_KEY;
      }
    });

    test('edits a recipe, with the same rules as saving, and can reset its status', async () => {
      const [id, other] = await saveRecipes('team-1', 2, { theme: 'soups' });
      await rest.POST(new Request(`http://x/api/recipes?id=${id}&action=processed`, { method: 'POST', headers: as('team-2') }));

      const edited = await admin('POST', 'recipe', { id, body: { name: 'Better soup', group: 'Team 9', status: 'new' } });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.deepEqual(
        [edited.body.recipe.name, edited.body.recipe.group, edited.body.recipe.status, edited.body.recipe.processed_by],
        ['Better soup', 'team-9', 'new', null],
      );

      const bad = await admin('POST', 'recipe', { id, body: { est_servings: 0, calories: 3 } });
      assert.equal(bad.status, 400);
      assert.deepEqual(bad.body.errors, ['est_servings must be at least 1', 'unknown field: calories']);
      assert.equal((await admin('POST', 'recipe', { id, body: {} })).status, 400);
      assert.equal((await admin('POST', 'recipe', { id: randomUUID(), body: { name: 'x' } })).status, 404);

      // Moving a recipe onto another one's group, theme and meal_id is a duplicate.
      const [dupTarget] = await saveRecipes('team-9', 1, { theme: 'soups' });
      const clash = await admin('POST', 'recipe', { id: dupTarget, body: { meal_id: (await listAll()).find((r) => r.id === id).meal_id } });
      assert.equal(clash.status, 409);

      const log = (await db.activity()).filter((a) => a.channel === 'admin');
      assert.deepEqual(log.map((a) => a.action), ['admin_edit_recipe']);
      void other;
    });

    test('deletes recipes, plans and the activity log', async () => {
      const ids = await saveRecipes('team-1', 5);
      await markPriced(db.pool, ids);
      const saved = await plansApi.POST(new Request('http://x/api/meal-plans', { method: 'POST', headers: { ...as('team-2'), 'content-type': 'application/json' }, body: JSON.stringify(mealPlan(ids)) }));
      const planId = (await saved.json()).plan.id;

      assert.equal((await admin('POST', 'delete-plan', { id: planId })).status, 200);
      assert.equal((await admin('POST', 'delete-plan', { id: planId })).status, 404);
      assert.equal((await db.plans()).length, 0);

      assert.equal((await admin('POST', 'delete-recipe', { id: ids[0] })).status, 200);
      assert.equal((await listAll()).length, 4);
      assert.equal((await admin('POST', 'delete-recipe', { id: 'nope' })).status, 400);

      assert.equal((await admin('POST', 'clear-activity')).status, 200);
      const left = await db.activity();
      assert.deepEqual(left.map((a) => a.action), ['admin_clear_activity']);
    });

    test('backup, reset and restore bring everything back exactly', async () => {
      const ids = await saveRecipes('team-1', 5);
      await rest.POST(new Request(`http://x/api/recipes?id=${ids[0]}&action=processed`, { method: 'POST', headers: as('team-2') }));
      await markPriced(db.pool, ids);
      await plansApi.POST(new Request('http://x/api/meal-plans', { method: 'POST', headers: { ...as('team-2'), 'content-type': 'application/json' }, body: JSON.stringify(mealPlan(ids)) }));
      const before = await listAll();

      const backup = await admin('GET', 'backup');
      assert.equal(backup.status, 200);
      assert.match(backup.headers.get('content-disposition'), /attachment; filename="recipes-backup-.*\.json"/);
      assert.deepEqual(backup.body.counts, { recipes: 5, plans: 1, activity: 7 });

      assert.equal((await admin('POST', 'reset', { body: { confirm: 'yes' } })).status, 400);
      assert.equal((await admin('POST', 'reset', { body: { confirm: 'RESET' } })).status, 200);
      assert.equal((await listAll()).length, 0);

      // A backup is plain JSON: it survives a round trip through a file.
      const file = JSON.parse(JSON.stringify(backup.body));
      const restored = await admin('POST', 'restore', { body: file });
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      assert.deepEqual(restored.body.counts, { recipes: 5, plans: 1, activity: 7 });

      const after = await listAll();
      const key = (r) => [r.id, r.group, r.status, r.processed_by, r.name, r.ingredients.length, new Date(r.created_at).toISOString()];
      assert.deepEqual(after.map(key).sort(), before.map(key).sort());
      const plans = await (await plansApi.GET(new Request('http://x/api/meal-plans'))).json();
      assert.equal(plans.plans[0].meals.length, 5);
      assert.equal(plans.plans[0].total_cost_usd, 10); // five dinners at $2 a serving
    });

    test('restore checks the whole file first and changes nothing if it’s wrong', async () => {
      await saveRecipes('team-1', 2);
      const backup = (await admin('GET', 'backup')).body;

      const notBackup = await admin('POST', 'restore', { body: { hello: 'world' } });
      assert.equal(notBackup.status, 400);
      assert.match(notBackup.body.errors.join(' '), /isn’t a Meal Squad backup file/);

      const broken = JSON.parse(JSON.stringify(backup));
      broken.recipes[1].est_servings = 0;
      delete broken.recipes[0].name;
      const res = await admin('POST', 'restore', { body: broken });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body.errors, ['recipes.0.name is missing', 'recipes.1.est_servings must be at least 1']);

      const twice = JSON.parse(JSON.stringify(backup));
      twice.recipes.push({ ...twice.recipes[0] });
      assert.match((await admin('POST', 'restore', { body: twice })).body.errors[0], /same id/);

      assert.equal((await admin('POST', 'restore', { body: 'not json' })).status, 400);
      assert.equal((await listAll()).length, 2, 'nothing was replaced');
    });

    test('the instructor sets the coordinator’s limits and checks; agents are held to them and told about them', async () => {
      assert.equal((await admin('GET', 'settings', { key: null })).status, 401);
      assert.equal((await admin('GET', 'settings')).body.settings.max_recipes_per_group, 10);
      assert.equal((await admin('POST', 'settings', { body: { max_recipes_per_group: -1 } })).status, 400);
      assert.match((await admin('POST', 'settings', { body: { checks: { calories_min: 900 } } })).body.errors[0], /calories_min/);

      const set = await admin('POST', 'settings', { body: { max_recipes_per_group: 2, max_plans_per_group: 1, max_saves_per_minute: 0, auto_pricing: false, checks: { require_vegetarian: false } } });
      assert.equal(set.status, 200, JSON.stringify(set.body));

      // Recipes per group, counting every pick.
      const ids = await saveRecipes('team-1', 2);
      const third = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as('team-1'), 'content-type': 'application/json' }, body: JSON.stringify(recipe()) }));
      assert.equal(third.status, 403);
      assert.match((await third.json()).errors[0], /already saved 2 recipes, the most this class allows \(2\)/);
      assert.equal((await saveRecipes('team-2', 1)).length, 1, 'other groups are unaffected');
      assert.ok((await listAll()).every((r) => r.pricing.status === 'unpriced'), 'automatic pricing is paused');

      // Plans per group; the checks follow the settings (no vegetarian check).
      const more = [...ids, ...(await saveRecipes('team-3', 2)), ...(await saveRecipes('team-2', 1))];
      await markPriced(db.pool, more);
      const post = (body) => plansApi.POST(new Request('http://x/api/meal-plans', { method: 'POST', headers: { ...as('team-4'), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      const first = await post(mealPlan(more));
      assert.equal(first.status, 201, JSON.stringify(await first.clone().json()));
      assert.equal((await first.json()).checks.length, 7, 'eight checks minus the vegetarian one');
      const second = await post(mealPlan(more));
      assert.equal(second.status, 403);

      // The brief states the limits.
      const { expectations } = await import('../lib/expectations.js');
      assert.match((await expectations('scout')).limits.join(' '), /at most 2 recipes/);
      assert.match((await expectations('scout')).storage_and_handoff.join(' '), /waits until the instructor/);

      // Save attempts per minute.
      await admin('POST', 'settings', { body: { max_recipes_per_group: 0, max_saves_per_minute: 3 } });
      const statuses = [];
      for (let i = 0; i < 3; i++) {
        statuses.push((await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as('team-5'), 'content-type': 'application/json' }, body: JSON.stringify(recipe()) }))).status);
      }
      const fourth = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as('team-5'), 'content-type': 'application/json' }, body: JSON.stringify(recipe()) }));
      assert.deepEqual([...statuses, fourth.status], [201, 201, 201, 429]);

      const reset = await admin('POST', 'settings', { body: { reset: true } });
      assert.equal(reset.body.settings.max_recipes_per_group, 10);
    });

    test('loads the fixed sample database, with or without ready-made prices', async () => {
      await saveRecipes('team-9', 1);
      assert.equal((await admin('POST', 'load-sample', { body: {} })).status, 400, 'needs the confirm word');
      assert.equal((await admin('GET', 'sample')).body.recipes, 20);

      const res = await admin('POST', 'load-sample', { body: { confirm: 'SAMPLE' } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const first = await listAll();
      assert.equal(first.length, 20);
      assert.ok(!first.some((r) => r.group === 'team-9'), 'everything was replaced');
      assert.ok(first.every((r) => r.pricing.status === 'priced' && r.pricing.estimated && r.pricing.cost_per_serving_usd > 0));
      assert.ok(first.some((r) => r.pick_count > 1), 'some recipes were picked by two groups');

      // Loading again gives exactly the same recipes.
      await admin('POST', 'load-sample', { body: { confirm: 'SAMPLE' } });
      const key = (r) => [r.id, r.meal_id, r.name, r.pick_count, r.pricing.cost_per_serving_usd];
      assert.deepEqual((await listAll()).map(key).sort(), first.map(key).sort());

      await admin('POST', 'load-sample', { body: { confirm: 'SAMPLE', prices: false } });
      assert.ok((await listAll()).every((r) => r.pricing.status === 'pending'), 'the Pricer prices them');
    });
  });
}

describe('edited sample prompts', { skip: BACKENDS[0].skip }, () => {
  test('the admin edits a step’s prompt; everyone reads it; reset goes back to the file', async () => {
    await BACKENDS[0].fresh();
    const promptsApi = await import('../api/prompts.js');
    const read = async (agent) => (await promptsApi.GET(new Request(`http://x/api/prompts?agent=${agent}`))).json();
    const write = (body, key = process.env.ADMIN_KEY) =>
      promptsApi.POST(new Request('http://x/api/prompts', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));

    assert.deepEqual((await read('scout')).steps, {});
    assert.equal((await promptsApi.GET(new Request('http://x/api/prompts?agent=chef'))).status, 400);

    const text = 'Build a web app called "Recipe Finder" for {{GROUP}} at {{SITE}}.';
    assert.equal((await write({ agent: 'scout', step: 1, text }, 'wrong')).status, 401);
    assert.equal((await write({ agent: 'scout', step: 1, text: 'short' })).status, 400);
    const bad = await write({ agent: 'scout', step: 1, text: 'Use {{KEY}} to sign in to the coordinator.' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).errors[0], /Unknown placeholder \{\{KEY\}\}/);

    assert.equal((await write({ agent: 'scout', step: 1, text })).status, 200);
    assert.equal((await write({ agent: 'planner', step: 3, text: `${text} (planner)` })).status, 200);
    assert.deepEqual((await read('scout')).steps, { 1: text });
    assert.deepEqual(Object.keys((await read('planner')).steps), ['3']);

    assert.equal((await write({ agent: 'scout', step: 1, reset: true })).status, 200);
    assert.deepEqual((await read('scout')).steps, {});
  });
});
