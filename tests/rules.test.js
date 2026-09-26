// The meal-plan rule library: the instructor switches rules on and off on the
// Admin page (or picks a preset), and the coordinator's checks, get_contract
// and the Meal Planner page all follow.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as rest from '../api/recipes.js';
import { GET as settingsApi } from '../api/settings.js';
import { checkPlan } from '../lib/plans.js';
import { contract } from '../lib/contract.js';
import { saveSettings, forgetSettings, getSettings, settingsSchema, PLAN_PRESETS } from '../lib/settings.js';
import { getStore } from '../lib/store/index.js';
import { BACKENDS, as, recipe, markPriced, closeDatabase } from './helpers.js';

after(closeDatabase);

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
// Five dinners: two Beef nights in a row, one slow one, one with peanuts.
const DINNERS = [
  { cuisine: 'Indian', category: 'Vegetarian', est_minutes: 25, cost: 2, ingredients: [{ name: 'chickpeas', amount: 400, unit: 'g', raw: '400g' }] },
  { cuisine: 'Mexican', category: 'Beef', est_minutes: 30, cost: 3, ingredients: [{ name: 'minced beef', amount: 500, unit: 'g', raw: '500g' }] },
  { cuisine: 'Thai', category: 'Beef', est_minutes: 90, cost: 6, ingredients: [{ name: 'beef', amount: 500, unit: 'g', raw: '500g' }, { name: 'Peanut Butter', amount: 2, unit: 'tbsp', raw: '2 tbsp' }] },
  { cuisine: 'Italian', category: 'Chicken', est_minutes: 20, cost: 2.5, ingredients: [{ name: 'chicken', amount: 1, unit: 'kg', raw: '1kg' }, { name: 'nutmeg', amount: 1, unit: 'tsp', raw: '1 tsp' }] },
  { cuisine: 'Italian', category: 'Pasta', est_minutes: 15, cost: 1.5, ingredients: [{ name: 'spaghetti', amount: 500, unit: 'g', raw: '500g' }] },
];

async function setRules(checks) {
  const res = await saveSettings({ checks });
  assert.ok(res.ok, JSON.stringify(res.errors));
  forgetSettings();
}
const byRule = (e) => Object.fromEntries(e.checks.map((c) => [c.rule, c]));

for (const backend of BACKENDS) {
  describe(`meal-plan rules, with the ${backend.name} store`, { skip: backend.skip }, () => {
    let ids;
    let plan;
    beforeEach(async () => {
      const db = await backend.fresh();
      forgetSettings();
      ids = [];
      for (const [n, d] of DINNERS.entries()) {
        const { cost, ...rest_ } = d;
        const res = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as(`team-${n}`), 'content-type': 'application/json' }, body: JSON.stringify(recipe({ name: `Dinner ${n}`, ...rest_ })) }));
        ids.push((await res.json()).recipe.id);
      }
      // Dinners 0 and 1 are also picked by a second group: popular.
      for (const n of [0, 1]) {
        await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as('team-x'), 'content-type': 'application/json' }, body: JSON.stringify(recipe({ name: `Dinner ${n}`, ...(({ cost, ...r }) => r)(DINNERS[n]), meal_id: (await getStore().recipesByIds([ids[n]])).get(ids[n]).meal_id, theme: `another theme ${n}` })) }));
      }
      await markPriced(db.pool, ids, (i) => DINNERS[i].cost);
      plan = { budget_usd: 5, summary: 'Five dinners.', meals: ids.map((recipe_id, i) => ({ day: DAYS[i], recipe_id, why: 'Good.' })) };
    });

    test('with every rule on, each one reports what breaks it', async () => {
      await setRules({
        min_cuisines: 5, max_same_category: 1, require_vegetarian: true, no_category_twice_in_a_row: true,
        max_dinner_usd: 4, max_minutes: 60, excluded_ingredients: 'peanut, shrimp', min_popular: 3,
      });
      const e = await checkPlan(plan);
      assert.ok(e.ok, JSON.stringify(e.errors));
      const r = byRule(e);
      assert.equal(e.checks.length, 9);
      assert.equal(r['The average dinner costs no more than the budget, per person'].passed, true);
      assert.deepEqual([r['At least 5 different cuisines'].passed, r['At least 5 different cuisines'].detail], [false, '4: Indian, Mexican, Thai, Italian']);
      assert.deepEqual(r['No category (e.g. Beef, Chicken) more than 1 time'].detail, 'Beef ×2');
      assert.equal(r['At least one vegetarian or vegan dinner'].passed, true);
      assert.equal(r['No category (e.g. Beef, Chicken) on two days in a row'].detail, 'Tuesday and Wednesday: Beef');
      assert.equal(r['No dinner costs more than $4.00 per person'].detail, 'Wednesday: Dinner 2 $6.00');
      assert.equal(r['No dinner takes more than 60 minutes (the Scout Agent’s estimate)'].detail, 'Wednesday: Dinner 2 90 min');
      assert.equal(r['No dinner contains peanut, shrimp'].detail, 'Wednesday: Dinner 2 (Peanut Butter)', 'capitals don’t matter, and nutmeg isn’t a nut');
      assert.deepEqual([r['At least 3 dinners scouted by two or more groups'].passed, r['At least 3 dinners scouted by two or more groups'].detail], [false, '2 of 5']);
      assert.equal(e.all_rules_passed, false);
    });

    test('rules that are off aren’t checked or listed; the budget always is', async () => {
      await setRules({ min_cuisines: 0, max_same_category: 0, require_vegetarian: false, no_category_twice_in_a_row: false, max_dinner_usd: 0, max_minutes: 0, excluded_ingredients: '', min_popular: 0 });
      const e = await checkPlan(plan);
      assert.deepEqual(e.checks.map((c) => c.rule), ['The average dinner costs no more than the budget, per person']);
      assert.equal(e.all_rules_passed, true);
      const brief = await contract('planner');
      assert.deepEqual(brief.checks.reported_for_every_plan.rules, ['The average dinner costs no more than the budget, per person']);
    });

    test('every preset is valid, and choosing one sets every rule', async () => {
      for (const [key, p] of Object.entries(PLAN_PRESETS)) {
        assert.ok(p.name && p.about, key);
        assert.ok(settingsSchema.shape.checks.safeParse(p.checks).success, key);
        await setRules(p.checks);
        assert.deepEqual((await getSettings()).checks, p.checks, key);
      }
      await setRules(PLAN_PRESETS.allergy.checks);
      const r = byRule(await checkPlan(plan));
      assert.equal(Object.keys(r).find((k) => k.startsWith('No dinner contains')).includes('peanut'), true);
    });

    test('the default is the Standard preset, and older saved settings keep working', async () => {
      assert.deepEqual((await getSettings()).checks, PLAN_PRESETS.standard.checks);
      // Settings saved before the rule library had only three rules.
      await getStore().setSettings({ checks: { min_cuisines: 4, max_same_category: 3, require_vegetarian: false } });
      forgetSettings();
      const c = (await getSettings()).checks;
      assert.deepEqual([c.min_cuisines, c.max_same_category, c.require_vegetarian, c.max_minutes, c.excluded_ingredients], [4, 3, false, 0, '']);
    });

    test('the Meal Planner page, get_contract and the Admin page get the rules and presets', async () => {
      await setRules({ ...PLAN_PRESETS.quick.checks });
      const body = await (await settingsApi(new Request('http://x/api/settings'))).json();
      assert.ok(body.plan_checks.includes('No dinner takes more than 30 minutes (the Scout Agent’s estimate)'));
      assert.deepEqual(Object.keys(body.plan_presets), Object.keys(PLAN_PRESETS));
      const brief = await contract('planner');
      assert.deepEqual(brief.checks.reported_for_every_plan.rules, body.plan_checks);
    });

    test('rule values are checked when saved', async () => {
      for (const bad of [{ max_minutes: -1 }, { max_dinner_usd: 1000 }, { excluded_ingredients: 'x'.repeat(301) }, { min_popular: 6 }, { surprise: true }]) {
        const res = await saveSettings({ checks: bad });
        assert.equal(res.ok, false, JSON.stringify(bad));
      }
    });
  });
}
