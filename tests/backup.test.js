// The instructor's backup agents: a scripted model stands in for the AI, so
// these check the harness: MCP discovery, the app's own checks, and the log.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as adminApi from '../api/admin.js';
import { setBackupForTests } from '../lib/backup-agents.js';
import { setPricerForTests } from '../lib/pricer.js';
import { resetKroger } from '../lib/kroger.js';
import { getStore } from '../lib/store/index.js';
import { saveChoice, planIngredients } from '../lib/shopper.js';
import { createShopper } from '../lib/shopper-agent.js';
import { BACKENDS, as, recipe, markPriced, closeDatabase } from './helpers.js';
import * as rest from '../api/recipes.js';
import * as plansApi from '../api/meal-plans.js';

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

    test('the Scout Agent finds tools over MCP, must look a recipe up before saving it, and stops at four', async () => {
      const turns = [
        [['get_contract', {}]],
        [['search_meals', { name: 'meal' }]],
        [['save_recipe', asRecipe(MEALS[0])]], // not looked up yet: the app refuses
        ...MEALS.slice(0, 5).map((m) => [['get_meal', { meal_id: m.idMeal }], ['save_recipe', asRecipe(m)]]), // the fifth is never reached
      ];
      const { model, seen } = scripted(turns);
      setBackupForTests({ model });
      const started = await api('POST', { body: { agent: 'scout', group: 'Backup Team', theme: 'cheap veggie' } });
      assert.equal(started.status, 202, JSON.stringify(started.body));

      const run = (await api('GET', { id: started.body.id })).body;
      assert.equal(run.status, 'done', JSON.stringify(run.steps.slice(-3)));
      assert.equal(run.outcome, 'Four recipes saved');
      assert.equal(run.group_name, 'backup-team');
      const toolNames = seen[0].tools.map((t) => t.name);
      assert.deepEqual(toolNames, ['get_contract', 'save_recipe', 'search_meals', 'filter_meals', 'get_meal', 'finish'], 'coordinator tools come from tools/list');
      assert.ok(run.steps.some((s) => s.kind === 'error' && /get_meal first/.test(s.text)));

      const recipes = await getStore().listRecipes({ status: 'all', limit: 50 });
      assert.equal(recipes.length, 4);
      const ex = await getStore().listExchanges({ group: 'backup-team', agent: 'scout', limit: 50 });
      assert.equal(ex.filter((e) => e.tool === 'save_recipe').length, 4, 'saves are logged like any agent’s');
      assert.match(JSON.stringify(ex), /tools\/list/);
    });

    test('the Meal Planner Agent must check the exact plan before saving it, and saves once', async () => {
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

    // A saved plan of five priced dinners. Every dinner uses half a 2 lb bag of the
    // same rice; Monday and Tuesday use onions the Pricer bought as different
    // products; Friday's own item is an estimate.
    async function planForShopper() {
      const ids = [];
      for (const [n, cuisine] of ['Indian', 'Italian', 'Thai', 'Mexican', 'Greek'].entries()) {
        const res = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as(`team-${n}`), 'content-type': 'application/json' }, body: JSON.stringify(recipe({ cuisine, category: n < 2 ? 'Vegetarian' : ['Beef', 'Chicken', 'Pork'][n - 2] })) }));
        ids.push((await res.json()).recipe.id);
      }
      const pool = getStore().pool;
      await markPriced(pool, ids, () => 2);
      for (const [n, id] of ids.entries()) {
        const basket = [
          { line: 1, ingredient: 'rice', status: 'bought', product: { id: 'rice-1', description: 'Kroger Rice', size: '2 lb', price_usd: 3 }, fraction: 0.5 },
          n === 4
            ? { line: 2, ingredient: 'saffron', status: 'estimated', reason: 'none at this store', product: { id: 'estimate-2', description: 'saffron', size: '1 g', price_usd: 9 }, fraction: 1 }
            : { line: 2, ingredient: n === 3 ? 'gruyère' : `item ${n}`, status: 'bought', product: { id: `p-${n}`, description: `Item ${n}`, size: '1 ea', price_usd: 4 }, fraction: 1, substitute_for: n === 3 ? 'gruyère: none at this store' : null },
          ...(n < 2 ? [{ line: 3, ingredient: 'yellow onion', status: 'bought', product: n === 0 ? { id: 'onion-3lb', description: 'Yellow Onions 3 lb Bag', size: '3 lb', price_usd: 3.49 } : { id: 'onion-1lb', description: 'Yellow Onions', size: '1 lb', price_usd: 1.29 }, fraction: n === 0 ? 0.2 : 0.5 }] : []),
          { line: 4, ingredient: 'water', status: 'skipped', reason: 'from the tap' },
        ];
        await pool.query('update pricings set basket = $2 where meal_id = (select meal_id from recipes where id = $1)', [id, JSON.stringify(basket)]);
      }
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
      const plan = { budget_usd: 3, summary: 'Five cheap dinners from five cuisines.', meals: ids.map((recipe_id, i) => ({ day: days[i], recipe_id, why: 'Cheap.' })) };
      const saved = await plansApi.POST(new Request('http://x/api/meal-plans', { method: 'POST', headers: { ...as('team-9'), 'content-type': 'application/json' }, body: JSON.stringify(plan) }));
      return (await saved.json()).plan.id;
    }
    // The Shopper's tools, calling the coordinator in-process as a run does.
    const coordCall = async (name, args) => {
      const r = await planIngredients(args);
      if (!r.ok) return { text: r.errors.join(' '), isError: true };
      const { ok, plan, ...data } = r;
      return { text: JSON.stringify(data), isError: false };
    };

    test('the coordinator serves a plan’s ingredients and checks the cart it is sent', async () => {
      const planId = await planForShopper();
      const ing = await planIngredients({ plan_id: planId });
      assert.deepEqual(ing.dinners.map((d) => d.needs.map((n) => n.need_id)), [['mon-1', 'mon-2', 'mon-3'], ['tue-1', 'tue-2', 'tue-3'], ['wed-1', 'wed-2'], ['thu-1', 'thu-2'], ['fri-1', 'fri-2']]);
      assert.deepEqual(ing.dinners[0].not_bought, ['water']);
      assert.equal(ing.dinners[4].needs[1].product.id, 'estimate-fri-2');

      const line = (needs, over = {}) => ({ product_id: 'x', description: 'X', size: '1 ea', price_usd: 2, packages: 1, cost_usd: 2, needs, ...over });
      const all = ['mon-1', 'mon-2', 'mon-3', 'tue-1', 'tue-2', 'tue-3', 'wed-1', 'wed-2', 'thu-1', 'thu-2', 'fri-1'];
      const bad = await saveChoice({ plan_id: planId, reason: 'A reason that is long enough to pass.', cart: { people: 50, lines: [line(all), line(['mon-1', 'nope'], { cost_usd: 5 })], total_usd: 3 } });
      assert.equal(bad.status, 400);
      assert.deepEqual(bad.errors, [
        'lines.1: mon-1 is already covered by lines.0',
        "lines.1: nope isn't a need_id of this plan",
        'lines.1: cost_usd should be packages × price_usd (2)',
        "these needs aren't in the cart: fri-2 (Friday: saffron)",
        'total_usd should be the sum of the lines (7)',
      ]);
      const good = await saveChoice({ plan_id: planId, reason: 'A reason that is long enough to pass.', cart: { people: 50, lines: [line([...all, 'fri-2'])], total_usd: 2 } });
      assert.ok(good.ok, JSON.stringify(good.errors));
      assert.deepEqual(good.choice.cart.lines[0].used_for.slice(0, 2), ['Monday: rice', 'Monday: item 0']);
    });

    test('the Shopper Agent builds the cart with its own tools and saves the class’s choice', async () => {
      const planId = await planForShopper();
      const reason = 'The only plan saved, and it passes every check at $2 a dinner.';
      const { model } = scripted([
        [['get_contract', {}], ['list_meal_plans', {}]],
        [['save_choice', { plan_id: planId, reason }]], // no cart yet: the app refuses
        [['start_cart', { plan_id: planId }]],
        [['save_choice', { plan_id: planId, reason }]], // the cart isn't complete: refused
        [['buy_as_priced', {}]],
        [['save_choice', { plan_id: planId, reason }]],
        [['save_choice', { plan_id: planId, reason }]], // a second choice: refused
        [['finish', { summary: 'Chose team-9’s plan.' }]],
      ]);
      setBackupForTests({ model });
      const started = await api('POST', { body: { agent: 'shopper' } });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      const run = (await api('GET', { id: started.body.id })).body;
      assert.equal(run.outcome, 'Plan chosen', JSON.stringify(run.steps.slice(-4)));
      assert.ok(run.steps.some((s) => /build this plan’s cart first/.test(s.text || '')));
      assert.ok(run.steps.some((s) => /some needs aren’t in the cart/.test(s.text || '')));
      assert.ok(run.steps.some((s) => /already saved a choice/.test(s.text || '')));
      assert.ok(run.steps[0].text.includes('get_plan_ingredients'), 'the coordinator offers it; start_cart uses it');

      const view = await (await plansApi.GET(new Request('http://x/api/meal-plans?choice=latest'))).json();
      assert.deepEqual([view.choice.plan_id, view.choice.reason, view.choice.plan.group_name, view.choice.status], [planId, reason, 'team-9', 'active']);
      const cart = view.choice.cart;
      const rice = cart.lines.find((l) => l.product_id === 'rice-1');
      assert.deepEqual([rice.packages, rice.cost_usd, rice.used_for.length], [3, 9, 5], 'five half bags: three bags, bought once');
      assert.equal(cart.lines.find((l) => l.product_id === 'p-3').substitutes[0], 'Thursday: instead of gruyère: none at this store');
      assert.deepEqual(cart.lines.filter((l) => l.estimated).map((l) => [l.product_id, l.packages]), [['estimate-fri-2', 1]]);
      assert.equal(cart.lines.length, 8, 'as priced, the two onion products are two lines');
      assert.equal(cart.people, 50);
      assert.match(cart.kroger_check, /Not checked with Kroger today/);
      assert.equal(view.run.input.people, 50);

      // Running the Shopper again: the new choice is active, the old one is history.
      const shopper = createShopper({ people: 100, coordCall });
      await shopper.run('start_cart', { plan_id: planId });
      await shopper.run('buy_as_priced', {});
      assert.equal(shopper.cart().lines.find((l) => l.product_id === 'rice-1').packages, 5, 'for 100 people: five bags');
      const big = createShopper({ people: 400, coordCall });
      await big.run('start_cart', { plan_id: planId });
      const bigRice = (await big.run('buy_as_priced', {})).check_stock.find((x) => x.product_id === 'rice-1');
      assert.deepEqual([bigRice.packages, bigRice.why], [20, '20 packages is a lot for one shelf']);
      assert.equal(big.cart().lines.find((l) => l.product_id === 'rice-1').stock_check, '20 packages is a lot for one shelf');
      assert.ok((await saveChoice({ plan_id: planId, reason: 'Chosen again for a bigger class.', cart: shopper.cart() })).ok);
      const again = await (await plansApi.GET(new Request('http://x/api/meal-plans?choice=latest'))).json();
      assert.deepEqual([again.choice.people, again.history.map((c) => c.status)], [100, ['historical']]);

      // Before class: the instructor clears the class's plan; the meal plans stay.
      const cleared = await adminApi.POST(new Request('http://x/api/admin?action=clear-choices', { method: 'POST', headers: { authorization: `Bearer ${process.env.ADMIN_KEY}` } }));
      assert.equal((await cleared.json()).cleared, 2);
      const empty = await (await plansApi.GET(new Request('http://x/api/meal-plans?choice=latest'))).json();
      assert.deepEqual([empty.choice, empty.history, empty.run], [null, [], null]);
      assert.equal((await (await plansApi.GET(new Request('http://x/api/meal-plans'))).json()).count, 1);
    });

    test('the Shopper checks Kroger today, combines an ingredient several dinners share, and replaces what the store no longer carries', async () => {
      const planId = await planForShopper();
      // Kroger today: the rice costs more, one item is no longer carried, one has no price. Stock levels are ignored.
      const TODAY = {
        'rice-1': { size: '2 lb', price: 3.5, stock: 'TEMPORARILY_OUT_OF_STOCK' },
        'p-1': { size: '1 ea', price: 4 },
        'p-2': { size: '1 ea', price: null },
        'p-3': { size: '1 ea', price: 4 },
        'onion-3lb': { size: '3 lb', price: 3.49 },
        'onion-1lb': { size: '1 lb', price: 1.29 },
        'alt-0': { size: '1 ea', price: 5 },
        'alt-2': { size: '8 oz', price: 2 },
        'rice-5lb': { size: '5 lb', price: 6 },
        'saffron-1': { size: '0.5 g', price: 7 },
      };
      const fetchImpl = async (url) => {
        const json = (status, body) => new Response(JSON.stringify(body), { status });
        if (url.endsWith('/connect/oauth2/token')) return json(200, { access_token: 'tok', expires_in: 1800 });
        if (url.includes('/locations')) return json(200, { data: [{ locationId: '01400943', name: 'Kroger Hyde Park', address: {} }] });
        if (url.includes('filter.term')) return json(200, { data: [{ productId: 'alt-0', description: 'Other Item', items: [{ size: '1 ea', price: { regular: 5 } }] }] });
        const id = url.match(/\/products\/([^?]+)/)?.[1];
        const p = TODAY[id];
        if (!p) return json(404, {});
        return json(200, { data: { productId: id, description: `Product ${id}`, items: [{ size: p.size, price: { regular: p.price }, ...(p.stock && { inventory: { stockLevel: p.stock } }) }] } });
      };
      process.env.KROGER_CLIENT_ID = 'id';
      process.env.KROGER_CLIENT_SECRET = 'secret';
      resetKroger();
      setPricerForTests({ fetch: fetchImpl });
      try {
        const shopper = createShopper({ people: 50, coordCall });
        const start = await shopper.run('start_cart', { plan_id: planId });
        assert.equal(start.needs_count, 12);
        assert.deepEqual(start.needs.filter((n) => n.ingredient === 'yellow onion').map((n) => [n.need_id, n.needed]), [['mon-3', 'about 9.6 oz'], ['tue-3', 'about 8 oz']]);
        assert.deepEqual(start.same_pricer_product.map((v) => [...v].sort()), [['fri-1', 'mon-1', 'thu-1', 'tue-1', 'wed-1']]);

        const priced = await shopper.run('buy_as_priced', {});
        assert.deepEqual(priced.not_carried_today.map((x) => [x.product_id, x.needs]), [['p-0', ['mon-2']], ['p-2', ['wed-2']]]);
        assert.deepEqual(priced.still_needed, ['mon-2', 'wed-2']);
        const rice = priced.lines.find((l) => l.product_id === 'rice-1');
        assert.deepEqual([rice.price_usd, rice.priced_at_usd, rice.packages], [3.5, 3, 3], 'today’s price');
        assert.equal(rice.check_stock, 'Kroger says it’s out of stock at the moment', 'a stock level is flagged, not trusted');
        assert.deepEqual(priced.check_stock.map((x) => x.product_id), ['rice-1']);
        assert.match(priced.check_stock_hint, /larger size/);

        // One bag of onions for both dinners: 0.6 lb + 0.5 lb is one 3 lb bag.
        const onions = await shopper.run('buy', { items: [{ product_id: 'onion-3lb', needs: ['mon-3', 'tue-3'], note: 'one bag for both' }] });
        assert.deepEqual([onions.results[0].packages, onions.results[0].needs], [1, ['mon-3', 'tue-3']]);
        // Replacements, and sizes that can't be converted.
        assert.equal((await shopper.run('search_kroger', { term: 'item' })).products[0].product_id, 'alt-0');
        const mixed = await shopper.run('buy', { items: [{ product_id: 'alt-0', needs: ['mon-2'] }, { product_id: 'alt-2', needs: ['wed-2'] }, { product_id: 'gone', needs: ['wed-2'] }] });
        assert.equal(mixed.results[0].packages, 1);
        assert.match(mixed.results[1].error, /can’t convert wed-2 \(1 ea\) into this product’s size \(8 oz\): give packages/);
        assert.match(mixed.results[2].error, /doesn’t carry it today/);
        await shopper.run('buy', { items: [{ product_id: 'alt-2', needs: ['wed-2'], packages: 2 }] });
        // The big bag of rice for everyone, and real saffron instead of the estimate.
        await shopper.run('buy', { items: [{ product_id: 'rice-5lb', needs: ['mon-1', 'tue-1', 'wed-1', 'thu-1', 'fri-1'] }, { product_id: 'saffron-1', needs: ['fri-2'] }] });
        assert.ok(shopper.complete());

        const cart = shopper.cart();
        const l = (id) => cart.lines.find((x) => x.product_id === id);
        assert.equal(cart.lines.find((x) => x.product_id === 'onion-1lb'), undefined, 'the 1 lb bag is gone');
        assert.deepEqual(l('onion-3lb').instead_of, ['Yellow Onions (1 lb)']);
        assert.deepEqual([l('rice-5lb').packages, l('rice-5lb').cost_usd], [1, 6], '2.5 bags of 2 lb is 5 lb: one 5 lb bag');
        assert.equal(l('rice-1'), undefined);
        assert.deepEqual([l('saffron-1').packages, l('saffron-1').estimated, l('saffron-1').instead_of], [2, undefined, ['saffron (1 g)']]);
        assert.deepEqual([l('alt-2').packages, l('alt-0').instead_of], [2, ['Item 0 (1 ea)']]);
        assert.equal(l('rice-5lb').stock_check, undefined, 'the big bag: one package, no stock level given');
        assert.match(cart.kroger_check, /Kroger Hyde Park today; 1 price changed since pricing\. 2 products are shared by several dinners and bought once\. Kroger’s stock levels are rough and can be unreliable: double-check quantities/);

        const saved = await saveChoice({ plan_id: planId, reason: 'The only plan, with one bag of onions and replacements.', cart });
        assert.ok(saved.ok, JSON.stringify(saved.errors));
        assert.equal(saved.choice.cart.estimated_lines, 0);
      } finally {
        setPricerForTests({ fetch: null });
        resetKroger();
        delete process.env.KROGER_CLIENT_ID;
        delete process.env.KROGER_CLIENT_SECRET;
      }
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
