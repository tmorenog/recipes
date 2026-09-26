// The instructor's backup agents: a scripted model stands in for the AI, so
// these check the harness: MCP discovery, the app's own checks, and the log.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as adminApi from '../api/admin.js';
import { setBackupForTests } from '../lib/backup-agents.js';
import { getStore } from '../lib/store/index.js';
import { BACKENDS, as, recipe, markPriced, closeDatabase } from './helpers.js';
import * as rest from '../api/recipes.js';

const ADMIN_KEY = 'admin-key-for-tests';
process.env.ADMIN_KEY = ADMIN_KEY;

const api = (method, { id, body, key = ADMIN_KEY } = {}) => adminApi[method](new Request(`http://x/api/admin?action=agent-runs${id ? `&id=${id}` : ''}`, {
  method,
  headers: { ...(key && { authorization: `Bearer ${key}` }), 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})).then(async (res) => ({ status: res.status, body: await res.json() }));

// A model that makes the given tool calls, one turn each.
function scripted(turns) {
  let i = 0;
  const seen = [];
  const model = async (params) => {
    seen.push(params);
    const calls = turns[i++] ?? [['finish', { summary: 'out of script' }]];
    return {
      stop_reason: 'tool_use',
      content: calls.map(([name, input], n) => ({ type: 'tool_use', id: `t${i}-${n}`, name, input })),
    };
  };
  return { model, seen };
}

const MEALS = Array.from({ length: 6 }, (_, n) => ({
  idMeal: String(52770 + n), strMeal: `Meal ${n}`, strCategory: 'Vegetarian', strArea: ['Indian', 'Italian', 'Thai', 'Mexican', 'Greek', 'French'][n],
  strInstructions: 'Cook everything together for twenty minutes, then serve.', strMealThumb: 'https://www.themealdb.com/images/media/meals/x.jpg',
  strIngredient1: 'Chickpeas', strMeasure1: '400g', strSource: '',
}));
const mealdbFetch = async (url) => {
  const u = new URL(url);
  const id = u.searchParams.get('i');
  const meals = u.pathname.endsWith('lookup.php') ? MEALS.filter((m) => m.idMeal === id) : MEALS;
  return new Response(JSON.stringify({ meals }), { status: 200 });
};
const asRecipe = (m) => ({
  theme: 'cheap veggie', meal_id: m.idMeal, name: m.strMeal, category: m.strCategory, cuisine: m.strArea,
  ingredients: [{ name: 'Chickpeas', amount: 400, unit: 'g', raw: '400g' }], instructions: m.strInstructions,
  est_minutes: 30, est_servings: 4, image_url: m.strMealThumb, source_url: null, why_chosen: 'Cheap and fits the theme.',
});

after(closeDatabase);

for (const backend of BACKENDS) {
  describe(`backup agents with the ${backend.name} store`, { skip: backend.skip }, () => {
    beforeEach(async () => {
      await backend.fresh();
      setBackupForTests({ model: null, fetch: mealdbFetch, background: false });
    });

    test('only the instructor can run them, and the input is checked', async () => {
      assert.equal((await api('GET', { key: null })).status, 401);
      assert.equal((await api('GET', { key: process.env.CLASS_KEY })).status, 401);
      setBackupForTests({ model: scripted([]).model });
      assert.equal((await api('POST', { body: { agent: 'scout', group: 'team-1' } })).status, 400);
      assert.equal((await api('POST', { body: { agent: 'chef', group: 'team-1', theme: 'x' } })).status, 400);
    });

    test('the Scout Agent finds tools over MCP, must look a recipe up before saving it, and stops at five', async () => {
      const turns = [
        [['get_contract', {}]],
        [['search_meals', { name: 'meal' }]],
        [['save_recipe', asRecipe(MEALS[0])]], // not looked up yet: the app refuses
        ...MEALS.slice(0, 5).map((m) => [['get_meal', { meal_id: m.idMeal }], ['save_recipe', asRecipe(m)]]),
      ];
      const { model, seen } = scripted(turns);
      setBackupForTests({ model });
      const started = await api('POST', { body: { agent: 'scout', group: 'Backup Team', theme: 'cheap veggie' } });
      assert.equal(started.status, 202, JSON.stringify(started.body));

      const run = (await api('GET', { id: started.body.id })).body;
      assert.equal(run.status, 'done', JSON.stringify(run.steps.slice(-3)));
      assert.equal(run.outcome, 'Five recipes saved');
      assert.equal(run.group_name, 'backup-team');
      const toolNames = seen[0].tools.map((t) => t.name);
      assert.deepEqual(toolNames, ['get_contract', 'save_recipe', 'search_meals', 'filter_meals', 'get_meal', 'finish'], 'coordinator tools come from tools/list');
      assert.ok(run.steps.some((s) => s.kind === 'error' && /get_meal first/.test(s.text)));

      const recipes = await getStore().listRecipes({ status: 'all', limit: 50 });
      assert.equal(recipes.length, 5);
      const ex = await getStore().listExchanges({ group: 'backup-team', agent: 'scout', limit: 50 });
      assert.equal(ex.filter((e) => e.tool === 'save_recipe').length, 5, 'saves are logged like any agent’s');
      assert.match(JSON.stringify(ex), /tools\/list/);
    });

    test('the Planner Agent must check the exact plan before saving it, and saves once', async () => {
      const ids = [];
      for (const [n, cuisine] of ['Indian', 'Italian', 'Thai', 'Mexican', 'Greek'].entries()) {
        const res = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as(`team-${n}`), 'content-type': 'application/json' }, body: JSON.stringify(recipe({ cuisine, category: n < 2 ? 'Vegetarian' : ['Beef', 'Chicken', 'Pork'][n - 2] })) }));
        ids.push((await res.json()).recipe.id);
      }
      await markPriced(getStore().pool, ids, () => 2);
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
      const plan = { budget_usd: 3, summary: 'Five cheap dinners from five cuisines.', meals: ids.map((recipe_id, i) => ({ day: days[i], recipe_id, why: 'Cheap.' })) };
      const reordered = { meals: plan.meals.map((m) => ({ why: m.why, recipe_id: m.recipe_id, day: m.day })), summary: plan.summary, budget_usd: 3 };
      const { model } = scripted([
        [['get_contract', {}], ['list_recipes', { priced: true }]],
        [['save_meal_plan', plan]], // not checked yet: the app refuses
        [['check_meal_plan', plan]],
        [['save_meal_plan', reordered]], // same plan, keys in another order
        [['save_meal_plan', plan]], // a second save: refused
        [['finish', { summary: 'Saved a plan that passes every check.' }]],
      ]);
      setBackupForTests({ model });
      const started = await api('POST', { body: { agent: 'planner', group: 'backup', budget_usd: 3 } });
      const run = (await api('GET', { id: started.body.id })).body;
      assert.equal(run.status, 'done', JSON.stringify(run.steps.slice(-3)));
      assert.equal(run.outcome, 'Valid plan found');
      assert.ok(run.steps.some((s) => /check this exact plan/.test(s.text || '')));
      assert.ok(run.steps.some((s) => /already saved a plan/.test(s.text || '')));
      assert.equal((await getStore().listPlans({ limit: 10 })).length, 1);

      const list = (await api('GET')).body;
      assert.equal(list.runs[0].outcome, 'Valid plan found');
      assert.equal(list.problem, null);
    });

    test('a model error ends the run as failed, with the reason', async () => {
      setBackupForTests({ model: async () => { throw new Error('overloaded'); } });
      const started = await api('POST', { body: { agent: 'scout', group: 'backup', theme: 'soup' } });
      const run = (await api('GET', { id: started.body.id })).body;
      assert.equal(run.status, 'failed');
      assert.match(run.summary, /overloaded/);
    });
  });
}
