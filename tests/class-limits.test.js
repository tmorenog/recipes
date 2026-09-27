// Limits that cap the Pricer's AI spend, with a message that says why:
// a total number of different recipes for the class, and the hourly limit,
// which leaves waiting recipes in the queue and says for how long.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as rest from '../api/recipes.js';
import * as pricerApi from '../api/pricer.js';
import { saveSettings, forgetSettings } from '../lib/settings.js';
import { contract } from '../lib/contract.js';
import { setMealDbForTests } from '../lib/mealdb.js';
import { setPricerForTests } from '../lib/pricer.js';
import { BACKENDS, as, recipe, closeDatabase } from './helpers.js';

process.env.ADMIN_KEY = 'admin-key-for-tests';

after(async () => {
  setMealDbForTests({ enabled: null });
  setPricerForTests({ auto: true });
  await closeDatabase();
});

async function save(group, r) {
  const res = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as(group), 'content-type': 'application/json' }, body: JSON.stringify(r) }));
  return { status: res.status, body: await res.json() };
}

for (const backend of BACKENDS) {
  describe(`class limits, with the ${backend.name} store`, { skip: backend.skip }, () => {
    let db;
    beforeEach(async () => {
      db = await backend.fresh();
      forgetSettings();
      setMealDbForTests({ enabled: false });
      setPricerForTests({ auto: false });
    });

    test('the class can store only so many different recipes; picking a saved one still works', async () => {
      await saveSettings({ max_recipes_total: 2 });
      forgetSettings();
      const a = recipe({ meal_id: '1' });
      assert.equal((await save('team-1', a)).status, 201);
      assert.equal((await save('team-2', recipe({ meal_id: '2' }))).status, 201);
      const full = await save('team-3', recipe({ meal_id: '3' }));
      assert.equal(full.status, 409);
      assert.match(full.body.errors[0], /limit of 2 different recipes/);
      assert.match(full.body.errors[0], /already saved can still be picked/);
      assert.equal((await save('team-3', { ...a, theme: 'another theme' })).status, 201, 'a recipe already stored can still be picked');
      assert.ok((await contract('scout')).limits.some((l) => /at most 2 different recipes/.test(l)));
      // Simultaneous saves can't pass the total.
      await saveSettings({ max_recipes_total: 5 });
      forgetSettings();
      await Promise.all(Array.from({ length: 6 }, (_, i) => save(`team-${i}`, recipe({ meal_id: String(10 + i) }))));
      assert.equal((await db.pool.query('select count(*)::int as n from recipes')).rows[0].n, 5);
    });

    test('when the hourly limit is reached, waiting recipes say why and for how long', async () => {
      await saveSettings({ max_priced_per_hour: 1 });
      forgetSettings();
      await save('team-1', recipe({ meal_id: '1' }));
      await save('team-1', recipe({ meal_id: '2' }));
      let overview = await (await pricerApi.GET(new Request('http://x/api/pricer'))).json();
      assert.equal(overview.pause, null, 'nothing priced yet this hour');
      await db.pool.query("update pricings set status = 'priced', attempts = 1, finished_at = now() - interval '20 minutes', people = 4, total_cost_usd = 8, to_buy_usd = 8 where meal_id = '1'");

      overview = await (await pricerApi.GET(new Request('http://x/api/pricer'))).json();
      assert.equal(overview.pause.per_hour, 1);
      assert.match(overview.pause.message, /priced 1 recipes in the last hour, the instructor’s limit/);
      assert.match(overview.pause.message, /about 40 minutes/);
      const listed = await (await rest.GET(new Request('http://x/api/recipes?status=all'))).json();
      assert.equal(listed.note, overview.pause.message, 'the Meal Planners are told too');

      await saveSettings({ max_priced_per_hour: 0 });
      forgetSettings();
      const unlimited = await (await rest.GET(new Request('http://x/api/recipes?status=all'))).json();
      assert.equal(unlimited.note, undefined);
    });
  });
}
