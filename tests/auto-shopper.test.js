// With no class plan yet, the Shopper Agent starts by itself once the
// instructor's number of meal plans are saved (Admin: auto_shopper_after_plans).
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as rest from '../api/recipes.js';
import * as plansApi from '../api/meal-plans.js';
import { getStore } from '../lib/store/index.js';
import { saveSettings, forgetSettings } from '../lib/settings.js';
import { setBackupForTests, AUTO_SHOPPER_GAP_MS } from '../lib/backup-agents.js';
import { BACKENDS, as, recipe, markPriced, closeDatabase } from './helpers.js';

process.env.ADMIN_KEY = 'admin-key-for-tests';

let modelCalls = 0;
const quickModel = async () => {
  modelCalls += 1;
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `f${modelCalls}`, name: 'finish', input: { summary: 'Test run.' } }] };
};

after(async () => {
  setBackupForTests({ model: null, background: true });
  await closeDatabase();
});

for (const backend of BACKENDS) {
  describe(`the Shopper Agent starting by itself, with the ${backend.name} store`, { skip: backend.skip }, () => {
    let ids;
    let db;
    beforeEach(async () => {
      db = await backend.fresh();
      forgetSettings();
      modelCalls = 0;
      setBackupForTests({ model: quickModel, background: false });
      ids = [];
      for (const [n, cuisine] of ['Indian', 'Italian', 'Thai', 'Mexican', 'Greek'].entries()) {
        const res = await rest.POST(new Request('http://x/api/recipes', { method: 'POST', headers: { ...as(`team-${n}`), 'content-type': 'application/json' }, body: JSON.stringify(recipe({ cuisine, category: ['Vegetarian', 'Beef', 'Chicken', 'Pork', 'Lamb'][n] })) }));
        ids.push((await res.json()).recipe.id);
      }
      await markPriced(db.pool, ids, () => 2);
    });

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    async function savePlan(group) {
      const plan = { budget_usd: 3, summary: 'Five cheap dinners from five cuisines.', meals: ids.map((recipe_id, i) => ({ day: days[i], recipe_id, why: 'Cheap.' })) };
      const res = await plansApi.POST(new Request('http://x/api/meal-plans', { method: 'POST', headers: { ...as(group), 'content-type': 'application/json' }, body: JSON.stringify(plan) }));
      assert.equal(res.status, 201, await res.clone().text());
    }
    const shopperRuns = async () => (await db.pool.query("select count(*)::int as n from backup_runs where agent = 'shopper'")).rows[0].n;

    test('it starts once the number of plans is reached, and not again straight away', async () => {
      await saveSettings({ auto_shopper_after_plans: 3 });
      forgetSettings();
      await savePlan('team-1');
      await savePlan('team-2');
      assert.equal(await shopperRuns(), 0, 'not before the third plan');
      await savePlan('team-3');
      assert.equal(await shopperRuns(), 1, 'the third plan starts it');
      const run = await getStore().latestAgentRun('shopper');
      assert.equal(run.group_name, 'shopper');
      assert.equal(run.input.people, 50);
      await savePlan('team-4');
      assert.equal(await shopperRuns(), 1, 'not again within 30 minutes, even though it chose nothing');

      // Half an hour later, still with no class plan, the next save tries again.
      await db.pool.query(`update backup_runs set created_at = now() - make_interval(secs => $1)`, [AUTO_SHOPPER_GAP_MS / 1000 + 60]);
      await savePlan('team-5');
      assert.equal(await shopperRuns(), 2);
    });

    test('it doesn’t start when the class already has a plan, when it is off, or while one is running', async () => {
      await saveSettings({ auto_shopper_after_plans: 1 });
      forgetSettings();
      await savePlan('team-1'); // the first plan starts it: no class plan yet
      assert.equal(await shopperRuns(), 1);
      await db.pool.query(
        `insert into class_choices (plan_id, reason, people, cart, total_usd)
         select id, 'Chosen by the instructor earlier.', 50, '{"people":50,"lines":[],"total_usd":0}'::jsonb, 0 from plans limit 1`,
      );
      await db.pool.query('delete from backup_runs');
      await savePlan('team-2');
      assert.equal(await shopperRuns(), 0, 'the class already has a plan');

      await db.pool.query('delete from class_choices');
      await saveSettings({ auto_shopper_after_plans: 0 });
      forgetSettings();
      await savePlan('team-3');
      assert.equal(await shopperRuns(), 0, '0 means only when the instructor runs it');

      await saveSettings({ auto_shopper_after_plans: 1 });
      forgetSettings();
      await db.pool.query(`insert into backup_runs (agent, group_name, input, status, created_at) values ('shopper', 'shopper', '{"agent":"shopper","people":50}', 'running', now() - interval '2 minutes')`);
      await savePlan('team-4');
      assert.equal(await shopperRuns(), 1, 'one is already running');
    });

    test('a failed start never stops the plan from being saved', async () => {
      await saveSettings({ auto_shopper_after_plans: 1 });
      forgetSettings();
      setBackupForTests({ model: async () => { throw new Error('the AI service is down'); } });
      await savePlan('team-1');
      assert.equal((await db.pool.query('select count(*)::int as n from plans')).rows[0].n, 1);
    });
  });
}
