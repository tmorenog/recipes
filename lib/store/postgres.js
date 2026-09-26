// Recipes, meal plans and the activity log, stored in Postgres.
import pg from 'pg';
import { poolConfig } from '../db.js';
import { StoreError, TABLES_MISSING } from './errors.js';
import { redact, redactDeep } from '../secrets.js';

const BASE_COLUMNS = `id, group_name, theme, meal_id, name, category, cuisine, ingredients, instructions,
  est_minutes, est_servings, image_url, source_url, why_chosen, status, created_at, processed_at, processed_by`;
const KEEP_EXCHANGES = 2000; // the exchange log keeps this many entries
const PRICE_COLUMNS = 'price_status, cost_per_serving_usd, cart_usd, priced_for, estimated_lines, price_estimated, priced_at';
// Every group that picked the recipe, first pick first.
const PICKS = `(select coalesce(json_agg(json_build_object('group', p.group_name, 'theme', p.theme, 'why_chosen', p.why_chosen, 'at', p.created_at)
   order by p.created_at, p.id), '[]'::json) from recipe_picks p where p.recipe_id = recipes.id) as picks`;
const COLUMNS = `${BASE_COLUMNS}, ${PRICE_COLUMNS}, ${PICKS}`;

// Postgres returns numeric columns as strings; the API returns numbers.
const money = (p) => p && { ...p, total_cost_usd: p.total_cost_usd == null ? null : Number(p.total_cost_usd), to_buy_usd: p.to_buy_usd == null ? null : Number(p.to_buy_usd) };
const numbers = (p) => p && { ...p, budget_usd: p.budget_usd == null ? null : Number(p.budget_usd), total_cost_usd: Number(p.total_cost_usd) };

async function run(pool, text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    if (e.code === '42P01') throw new StoreError(TABLES_MISSING);
    throw e;
  }
}

export function postgresStore(urlOrPool) {
  // Serverless functions run many small instances, so keep each pool tiny.
  const pool = typeof urlOrPool === 'string' ? new pg.Pool({ ...poolConfig(urlOrPool), max: 3, idleTimeoutMillis: 10_000 }) : urlOrPool;

  return {
    pool,

    // A group picks a recipe. The first pick of a TheMealDB recipe creates it;
    // later picks (other groups, or other themes) are added to it.
    // Returns { row, created } or { duplicate: true } if this group already
    // picked it for this theme.
    // maxPicks > 0: the group's limit, checked again here under a per-group
    // lock, so saves sent at the same moment can't pass it together.
    async saveRecipePick(r, { maxPicks = 0 } = {}) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (maxPicks > 0) {
          await client.query('select pg_advisory_xact_lock(hashtext($1))', [`group:${r.group_name}`]);
          const { rows: [u] } = await client.query('select count(*)::int as n from recipe_picks where group_name = $1', [r.group_name]);
          if (u.n >= maxPicks) {
            await client.query('rollback');
            return { limit: u.n };
          }
        }
        let created = false;
        let { rows } = await client.query('select id from recipes where meal_id = $1 for update', [r.meal_id]);
        if (!rows[0]) {
          ({ rows } = await client.query(
            `insert into recipes (group_name, theme, meal_id, name, category, cuisine, ingredients, instructions,
               est_minutes, est_servings, image_url, source_url, why_chosen)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             on conflict (meal_id) do nothing returning id`,
            [r.group_name, r.theme, r.meal_id, r.name, r.category, r.cuisine, JSON.stringify(r.ingredients),
              r.instructions, r.est_minutes, r.est_servings, r.image_url, r.source_url, r.why_chosen],
          ));
          created = Boolean(rows[0]);
          if (!rows[0]) ({ rows } = await client.query('select id from recipes where meal_id = $1', [r.meal_id])); // saved at the same moment
        }
        const id = rows[0].id;
        const pick = await client.query(
          `insert into recipe_picks (recipe_id, group_name, theme, why_chosen) values ($1, $2, $3, $4)
           on conflict (recipe_id, group_name, theme) do nothing returning id`,
          [id, r.group_name, r.theme, r.why_chosen],
        );
        if (!pick.rows[0]) {
          await client.query('rollback');
          return { duplicate: true };
        }
        await client.query('commit');
        const row = (await client.query(`select ${COLUMNS} from recipes where id = $1`, [id])).rows[0]; // same connection, as in claimPricing
        return { row, created };
      } catch (e) {
        await client.query('rollback').catch(() => {});
        if (e.code === '42P01') throw new StoreError(TABLES_MISSING);
        throw e;
      } finally {
        client.release();
      }
    },

    // priced: true / false filters before the limit, so no priced recipe is cut off.
    async listRecipes({ status, theme, group, priced, limit }) {
      const where = [];
      const params = [];
      if (status !== 'all') where.push(`status = $${params.push(status)}`);
      if (priced === true) where.push(`price_status = 'priced'`);
      if (priced === false) where.push(`price_status <> 'priced'`);
      if (theme) where.push(`exists (select 1 from recipe_picks p where p.recipe_id = recipes.id and p.theme = $${params.push(theme)})`);
      if (group) where.push(`exists (select 1 from recipe_picks p where p.recipe_id = recipes.id and p.group_name = $${params.push(group)})`);
      const { rows } = await run(
        pool,
        `select ${COLUMNS} from recipes ${where.length ? `where ${where.join(' and ')}` : ''}
         order by created_at desc limit $${params.push(limit)}`,
        params,
      );
      return rows;
    },

    async markProcessed(id, group) {
      const { rows } = await run(
        pool,
        `update recipes set status = 'processed', processed_at = now(), processed_by = $2
         where id = $1 and status = 'new' returning ${COLUMNS}`,
        [id, group],
      );
      return rows[0] ?? null;
    },

    async getRecipe(id) {
      const { rows } = await run(pool, `select ${COLUMNS} from recipes where id = $1`, [id]);
      return rows[0] ?? null;
    },

    async recipesByIds(ids) {
      const { rows } = await run(pool, `select ${COLUMNS} from recipes where id = any($1::uuid[])`, [ids]);
      return new Map(rows.map((r) => [r.id, r]));
    },

    // TheMealDB meal_id → the recipe's id (each meal is stored once).
    async recipeIdsByMealIds(mealIds) {
      const { rows } = await run(pool, 'select id, meal_id from recipes where meal_id = any($1::text[])', [mealIds]);
      return new Map(rows.map((r) => [r.meal_id, r.id]));
    },

    async recipeStatuses(ids) {
      const { rows } = await run(pool, 'select id, status from recipes where id = any($1::uuid[])', [ids]);
      return new Map(rows.map((r) => [r.id, r.status]));
    },

    // maxPlans > 0: the group's limit, checked again under a per-group lock (as saveRecipePick).
    async insertPlan(p, { maxPlans = 0 } = {}) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (maxPlans > 0) {
          await client.query('select pg_advisory_xact_lock(hashtext($1))', [`group:${p.group_name}`]);
          const { rows: [u] } = await client.query('select count(*)::int as n from plans where group_name = $1', [p.group_name]);
          if (u.n >= maxPlans) {
            await client.query('rollback');
            return { limit: u.n };
          }
        }
        const { rows } = await client.query(
          `insert into plans (group_name, summary, budget_usd, total_cost_usd, store_id, meals, shopping_list, rule_checks)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
          [p.group_name, p.summary, p.budget_usd, p.total_cost_usd, p.store_id, JSON.stringify(p.meals),
            JSON.stringify(p.shopping_list), JSON.stringify(p.rule_checks)],
        );
        await client.query('commit');
        return numbers(rows[0]);
      } catch (e) {
        await client.query('rollback').catch(() => {});
        if (e.code === '42P01') throw new StoreError(TABLES_MISSING);
        throw e;
      } finally {
        client.release();
      }
    },

    async getPlan(id) {
      const { rows } = await run(pool, 'select * from plans where id = $1', [id]);
      return rows[0] ? numbers(rows[0]) : null;
    },

    // The Pricer's cart for each of these meals: status, people and lines.
    async pricingCarts(mealIds) {
      const { rows } = await run(pool, 'select meal_id, status, people, basket from pricings where meal_id = any($1)', [mealIds]);
      return new Map(rows.map((r) => [r.meal_id, r]));
    },

    // ---- the Shopper Agent's choice of the class's plan
    async saveChoice({ plan_id, reason, people, cart, total_usd }) {
      const { rows } = await run(
        pool,
        'insert into class_choices (plan_id, reason, people, cart, total_usd) values ($1, $2, $3, $4, $5) returning *',
        [plan_id, reason, people, JSON.stringify(cart), total_usd],
      );
      return { ...rows[0], total_usd: Number(rows[0].total_usd) };
    },
    // Every choice, newest first (the newest is the class's), each with its plan.
    async listChoices(limit = 20) {
      const { rows } = await run(
        pool,
        `select c.*, row_to_json(p) as plan from class_choices c join plans p on p.id = c.plan_id order by c.created_at desc limit $1`,
        [limit],
      );
      return rows.map((r) => ({ ...r, total_usd: Number(r.total_usd), plan: numbers(r.plan) }));
    },
    async latestChoice() {
      const { rows } = await run(pool, 'select * from class_choices order by created_at desc limit 1');
      return rows[0] ? { ...rows[0], total_usd: Number(rows[0].total_usd) } : null;
    },

    async listPlans({ group, limit }) {
      const params = [];
      const where = group ? `where group_name = $${params.push(group)}` : '';
      const { rows } = await run(pool, `select * from plans ${where} order by created_at desc limit $${params.push(limit)}`, params);
      return rows.map(numbers);
    },

    async listActivity({ group, ok, limit }) {
      const where = [];
      const params = [];
      if (group) where.push(`group_name = $${params.push(group)}`);
      if (ok !== undefined) where.push(`ok = $${params.push(ok)}`);
      const { rows } = await run(
        pool,
        `select * from activity ${where.length ? `where ${where.join(' and ')}` : ''} order by id desc limit $${params.push(limit)}`,
        params,
      );
      return rows.map((r) => ({ ...r, id: Number(r.id) }));
    },

    // Secrets are removed before anything is stored.
    async logActivity(e) {
      try {
        await pool.query(
          'insert into activity (group_name, channel, action, ok, detail, input) values ($1, $2, $3, $4, $5, $6)',
          [e.group_name, e.channel, e.action, e.ok, e.detail == null ? null : redact(e.detail), e.input == null ? null : JSON.stringify(redactDeep(e.input))],
        );
      } catch (err) {
        console.error('activity log failed:', err.message); // logging must never break a request
      }
    },

    // ---- admin
    // The recipe and its first pick change together, or not at all. A change
    // to what the price depends on (meal_id, ingredients, servings) drops the
    // old price and queues the recipe again with repriceStatus.
    // Returns { row, repriced } | { row: null } | { duplicate: true } | { pickConflict: true }.
    async updateRecipe(id, fields, { repriceStatus = 'pending' } = {}) {
      const cols = Object.keys(fields);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const values = cols.map((c) => (c === 'ingredients' ? JSON.stringify(fields[c]) : fields[c]));
      const client = await pool.connect();
      try {
        await client.query('begin');
        const priceInputs = 'select meal_id, ingredients::text as ingredients, est_servings from recipes where id = $1';
        const before = (await client.query(`${priceInputs} for update`, [id])).rows[0];
        if (!before) {
          await client.query('rollback');
          return { row: null };
        }
        await client.query(`update recipes set ${sets} where id = $1`, [id, ...values]);
        const pickFields = { group_name: fields.group_name, theme: fields.theme, why_chosen: fields.why_chosen };
        const keys = Object.keys(pickFields).filter((k) => pickFields[k] !== undefined);
        if (keys.length) {
          try {
            await client.query(
              `update recipe_picks set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}
               where id = (select id from recipe_picks where recipe_id = $1 order by created_at, id limit 1)`,
              [id, ...keys.map((k) => pickFields[k])],
            );
          } catch (e) {
            if (e.code !== '23505') throw e;
            await client.query('rollback');
            return { pickConflict: true };
          }
        }
        const after = (await client.query(priceInputs, [id])).rows[0];
        const mealId = after.meal_id;
        const moved = mealId !== before.meal_id;
        const repriced = moved || after.ingredients !== before.ingredients || after.est_servings !== before.est_servings;
        if (repriced) {
          // Each meal is stored once, so the old meal_id's price belonged to this recipe only.
          if (moved) await client.query('delete from pricings where meal_id = $1', [before.meal_id]);
          await client.query('delete from pricer_steps where meal_id = $1', [mealId]);
          await client.query(
            `insert into pricings (meal_id, status) values ($1, $2)
             on conflict (meal_id) do update set status = excluded.status, attempts = 0, claimed_at = null, claim_token = null,
               finished_at = null, error = null, summary = null, basket = '[]'::jsonb, total_cost_usd = null, to_buy_usd = null,
               nutrition_total = null, tool_calls = 0, messages = null, people = null, prompt = null, created_at = now(), updated_at = now()`,
            [mealId, repriceStatus],
          );
        }
        const row = (await client.query(`select ${COLUMNS} from recipes where id = $1`, [id])).rows[0];
        await client.query('commit');
        return { row, repriced };
      } catch (e) {
        await client.query('rollback').catch(() => {});
        if (e.code === '23505') return { duplicate: true };
        if (e.code === '42P01') throw new StoreError(TABLES_MISSING);
        throw e;
      } finally {
        client.release();
      }
    },

    async deleteRecipe(id) {
      const { rowCount } = await run(pool, 'delete from recipes where id = $1', [id]);
      return rowCount > 0;
    },

    async deletePlan(id) {
      const { rowCount } = await run(pool, 'delete from plans where id = $1', [id]);
      return rowCount > 0;
    },

    async clearActivity() {
      await run(pool, 'delete from activity');
    },

    // ------------------------------------------------------------ exchanges
    async logExchange(e) {
      await run(
        pool,
        `insert into exchanges (group_name, agent, method, tool, ok, request, request_summary, response, summary, ms)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [e.group_name ?? null, e.agent ?? null, e.method, e.tool ?? null, e.ok, e.request == null ? null : JSON.stringify(e.request),
          e.request_summary ?? null, e.response == null ? null : JSON.stringify(e.response), e.summary ?? null, e.ms ?? null],
      );
      // Keep the newest entries only.
      await run(pool, 'delete from exchanges where id <= (select max(id) from exchanges) - $1', [KEEP_EXCHANGES]);
    },

    // Newest first. afterId: only entries newer than that id (for live updates).
    async listExchanges({ limit = 200, group = null, agent = null, afterId = null } = {}) {
      const { rows } = await run(
        pool,
        `select id, at, group_name, agent, method, tool, ok, request, request_summary, response, summary, ms from exchanges
          where ($1::text is null or group_name = $1) and ($2::text is null or agent = $2) and ($3::bigint is null or id > $3)
          order by id desc limit $4`,
        [group, agent, afterId, limit],
      );
      return rows.map((r) => ({ ...r, id: Number(r.id) }));
    },

    async clearExchanges() {
      await run(pool, 'delete from exchanges');
    },

    async exportAll() {
      const [r, p, a] = await Promise.all([
        run(pool, `select ${COLUMNS} from recipes order by created_at`),
        run(pool, 'select * from plans order by created_at'),
        run(pool, 'select at, group_name, channel, action, ok, detail, input from activity order by id'),
      ]);
      return { recipes: r.rows, plans: p.rows.map(numbers), activity: a.rows };
    },

    // Replaces everything in one transaction: all of the backup or nothing.
    async replaceAll({ recipes, plans, activity }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('delete from activity; delete from exchanges; delete from plans; delete from recipe_picks; delete from recipes; delete from pricer_steps; delete from pricings;');
        // One recipe per meal: a backup from an earlier version may hold the same
        // meal several times; the first copy is kept and the others become picks.
        const keptId = new Map();
        for (const r of [...recipes].sort((x, y) => new Date(x.created_at) - new Date(y.created_at))) {
          const ins = await client.query(
            `insert into recipes (id, group_name, theme, meal_id, name, category, cuisine, ingredients, instructions, est_minutes,
               est_servings, image_url, source_url, why_chosen, status, created_at, processed_at, processed_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             on conflict (meal_id) do nothing returning id`,
            [r.id, r.group_name, r.theme, r.meal_id, r.name, r.category ?? null, r.cuisine ?? null, JSON.stringify(r.ingredients), r.instructions,
              r.est_minutes, r.est_servings, r.image_url ?? null, r.source_url ?? null, r.why_chosen, r.status, r.created_at, r.processed_at ?? null, r.processed_by ?? null],
          );
          const kept = ins.rows[0]?.id ?? (await client.query('select id from recipes where meal_id = $1', [r.meal_id])).rows[0].id;
          keptId.set(r.id, kept);
          const picks = r.picks?.length ? r.picks : [{ group: r.group_name, theme: r.theme, why_chosen: r.why_chosen, at: r.created_at }];
          for (const pk of picks) {
            await client.query(
              `insert into recipe_picks (recipe_id, group_name, theme, why_chosen, created_at) values ($1, $2, $3, $4, $5)
               on conflict (recipe_id, group_name, theme) do nothing`,
              [kept, pk.group, pk.theme, pk.why_chosen, pk.at ?? r.created_at],
            );
          }
        }
        for (const p of plans) {
          p.meals = p.meals.map((m) => (m.recipe_id && keptId.has(m.recipe_id) ? { ...m, recipe_id: keptId.get(m.recipe_id) } : m));
          await client.query(
            `insert into plans (id, group_name, summary, budget_usd, total_cost_usd, store_id, meals, shopping_list, rule_checks, created_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [p.id, p.group_name, p.summary, p.budget_usd ?? null, p.total_cost_usd, p.store_id ?? null, JSON.stringify(p.meals),
              JSON.stringify(p.shopping_list), JSON.stringify(p.rule_checks ?? []), p.created_at],
          );
        }
        for (const a of activity) {
          await client.query(
            'insert into activity (at, group_name, channel, action, ok, detail, input) values ($1,$2,$3,$4,$5,$6,$7)',
            [a.at, a.group_name ?? null, a.channel, a.action, a.ok, a.detail ?? null, a.input == null ? null : JSON.stringify(a.input)],
          );
        }
        // The restored recipes are priced again from scratch.
        await client.query('insert into pricings (meal_id) select distinct meal_id from recipes on conflict do nothing');
        await client.query('commit');
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    // ------------------------------------------------------------ the Pricer
    // status 'unpriced' when automatic pricing is paused: it waits for the instructor.
    async enqueuePricing(mealId, status = 'pending') {
      // A recipe saved again (after it was deleted) keeps its earlier price; one that
      // was never priced (failed, or cleared) is queued again when pricing is on.
      await run(
        pool,
        `insert into pricings (meal_id, status) values ($1, $2) on conflict (meal_id) do update
           set status = case when pricings.status in ('failed', 'unpriced') and excluded.status = 'pending' then 'pending' else pricings.status end,
               attempts = case when pricings.status in ('failed', 'unpriced') and excluded.status = 'pending' then 0 else pricings.attempts end`,
        [mealId, status],
      );
    },

    // Recipes the Recipe Pricer finished (priced or not) since a moment in time.
    async pricingsFinishedSince(since) {
      const { rows } = await run(pool, "select count(*)::int as n from pricings where finished_at >= $1 and status in ('priced', 'failed')", [since]);
      return rows[0].n;
    },

    // Takes the next recipe waiting to be priced, or one whose run stopped
    // without finishing (claimed more than staleSeconds ago). At most maxActive
    // run at once. Returns the pricing with its recipe, or null.
    async claimPricing({ maxActive = 2, staleSeconds = 300, maxAttempts = 3 } = {}) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // One claim at a time across every server instance, so maxActive holds.
        await client.query("select pg_advisory_xact_lock(hashtext('pricings_claim'))");
        const active = await client.query(
          `select count(*)::int as n from pricings where status = 'pricing' and claimed_at > now() - make_interval(secs => $1)`,
          [staleSeconds],
        );
        if (active.rows[0].n >= maxActive) {
          await client.query('rollback');
          return null;
        }
        // Runs that keep stopping part-way are given up on, with the reason.
        await client.query(
          `update pricings set status = 'failed', error = coalesce(error, 'stopped part-way ' || attempts || ' times'), finished_at = now(), updated_at = now()
           where status = 'pricing' and claimed_at < now() - make_interval(secs => $1) and attempts >= $2`,
          [staleSeconds, maxAttempts],
        );
        const { rows } = await client.query(
          `update pricings set status = 'pricing', claimed_at = now(), attempts = attempts + 1, claim_token = gen_random_uuid(), updated_at = now()
           where meal_id = (
             select meal_id from pricings
             where status = 'pending' or (status = 'pricing' and claimed_at < now() - make_interval(secs => $1))
             order by created_at limit 1 for update skip locked)
           returning *`,
          [staleSeconds],
        );
        await client.query('commit');
        if (!rows[0]) return null;
        // On the same connection: asking the pool for another while holding
        // this one can wait forever when every connection is doing the same.
        const recipe = await client.query(
          'select name, ingredients, est_servings, image_url from recipes where meal_id = $1 order by created_at limit 1',
          [rows[0].meal_id],
        );
        return { ...rows[0], recipe: recipe.rows[0] ?? null };
      } catch (e) {
        await client.query('rollback').catch(() => {});
        if (e.code === '42P01') throw new StoreError(TABLES_MISSING);
        throw e;
      } finally {
        client.release();
      }
    },

    async pricingWork() {
      const { rows } = await run(
        pool,
        `select count(*) filter (where status = 'pending')::int as pending,
                count(*) filter (where status = 'pricing' and claimed_at > now() - interval '5 minutes')::int as active,
                count(*) filter (where status = 'pricing' and claimed_at <= now() - interval '5 minutes')::int as stale
         from pricings`,
      );
      return rows[0];
    },

    // A run's writes count only while it still holds its claim (token): a
    // recipe reset or taken over by another run is left alone. Each returns
    // whether it wrote.
    async savePricingProgress(mealId, { messages, basket, toolCalls, storeId, token }) {
      const { rowCount } = await run(
        pool,
        `update pricings set messages = $2, basket = $3, tool_calls = $4, store_id = coalesce($5, store_id), claimed_at = now(), updated_at = now()
         where meal_id = $1 and status = 'pricing' and claim_token = $6`,
        [mealId, JSON.stringify(messages), JSON.stringify(basket), toolCalls, storeId ?? null, token],
      );
      return rowCount > 0;
    },

    async finishPricing(mealId, { status, error = null, summary = null, people = null, prompt = null, basket, total, toBuy, nutrition, token }) {
      const { rowCount } = await run(
        pool,
        `update pricings set status = $2, error = $3, summary = $4, basket = coalesce($5, basket), total_cost_usd = $6, to_buy_usd = $7,
           nutrition_total = $8, people = $9, prompt = coalesce($10, prompt), finished_at = now(), updated_at = now(), messages = null,
           claim_token = null
         where meal_id = $1 and status = 'pricing' and claim_token = $11`,
        [mealId, status, error, summary, basket ? JSON.stringify(basket) : null, total ?? null, toBuy ?? null,
          nutrition ? JSON.stringify(nutrition) : null, people, prompt, token],
      );
      return rowCount > 0;
    },

    // A run that ran out of time hands the recipe back to the queue.
    async releasePricing(mealId, token) {
      const { rowCount } = await run(
        pool,
        `update pricings set status = 'pending', claimed_at = null, claim_token = null, updated_at = now()
         where meal_id = $1 and status = 'pricing' and claim_token = $2`,
        [mealId, token],
      );
      return rowCount > 0;
    },

    // ------------------------------------------------------------ limits
    async getSettings() {
      const { rows } = await run(pool, "select value from coordinator_settings where key = 'main'");
      return rows[0]?.value ?? null;
    },

    // The instructor's notes for the class, shown on the FAQ page.
    async getNotes() {
      const { rows } = await run(pool, "select value, updated_at from coordinator_settings where key = 'notes'");
      return rows[0] ? { text: rows[0].value?.text ?? '', updated_at: rows[0].updated_at } : { text: '', updated_at: null };
    },
    async setNotes(text) {
      const { rows } = await run(
        pool,
        `insert into coordinator_settings (key, value) values ('notes', $1)
         on conflict (key) do update set value = excluded.value, updated_at = now() returning updated_at`,
        [JSON.stringify({ text })],
      );
      return { text, updated_at: rows[0].updated_at };
    },

    async setSettings(value) {
      if (value == null) return run(pool, "delete from coordinator_settings where key = 'main'");
      await run(
        pool,
        `insert into coordinator_settings (key, value) values ('main', $1)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [JSON.stringify(value)],
      );
    },

    // How much a group has saved, and how many save attempts it made recently.
    async groupUsage(group) {
      const { rows } = await run(
        pool,
        `select (select count(*)::int from recipe_picks where group_name = $1) as picks,
                (select count(*)::int from plans where group_name = $1) as plans`,
        [group],
      );
      return rows[0];
    },

    async recentAttempts(group, since) {
      const { rows } = await run(
        pool,
        // Attempts turned away by this limit don't count, so an agent that waits gets back in.
        `select count(*)::int as n from activity where group_name = $1 and action in ('save_recipe', 'save_meal_plan') and at >= $2
           and not (ok = false and coalesce(detail, '') like 'too many save attempts%')`,
        [group, since],
      );
      return rows[0].n;
    },

    async getPricerConfig(key) {
      const { rows } = await run(pool, 'select value from pricer_config where key = $1', [key]);
      return rows[0]?.value ?? null;
    },

    async setPricerConfig(key, value) {
      if (value == null) return run(pool, 'delete from pricer_config where key = $1', [key]);
      await run(
        pool,
        'insert into pricer_config (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()',
        [key, value],
      );
    },

    // Admin: price one recipe again from scratch.
    async resetPricing(mealId) {
      await run(pool, 'delete from pricer_steps where meal_id = $1', [mealId]);
      const { rowCount } = await run(
        pool,
        `update pricings set status = 'pending', attempts = 0, claimed_at = null, finished_at = null, error = null, summary = null,
           basket = '[]'::jsonb, total_cost_usd = null, to_buy_usd = null, nutrition_total = null, tool_calls = 0, messages = null,
           people = null, prompt = null, created_at = now(), updated_at = now()
         where meal_id = $1`,
        [mealId],
      );
      return rowCount > 0;
    },

    async addPricerStep({ meal_id, attempt, kind, tool = null, input = null, output = null, text = null }) {
      await run(
        pool,
        'insert into pricer_steps (meal_id, attempt, kind, tool, input, output, text) values ($1, $2, $3, $4, $5, $6, $7)',
        [meal_id, attempt, kind, tool, input == null ? null : JSON.stringify(input), output == null ? null : JSON.stringify(output), text],
      );
    },

    async listPricings({ limit = 200 } = {}) {
      const { rows } = await run(
        pool,
        `select p.meal_id, p.status, p.store_id, p.attempts, p.error, p.total_cost_usd, p.to_buy_usd, p.nutrition_total, p.people,
                p.tool_calls, p.created_at, p.updated_at, p.finished_at, jsonb_array_length(p.basket) as lines_done, md5(p.prompt) as prompt_md5,
                (select count(*) from jsonb_array_elements(p.basket) e where e->>'status' = 'estimated')::int as estimated_lines,
                r.name, r.image_url, r.est_servings, jsonb_array_length(r.ingredients) as lines, r.groups
         from pricings p
         left join lateral (
           select name, image_url, est_servings, ingredients,
             (select array_agg(distinct pk.group_name) from recipe_picks pk join recipes rr on rr.id = pk.recipe_id where rr.meal_id = p.meal_id) as groups
           from recipes where meal_id = p.meal_id order by created_at limit 1) r on true
         order by case p.status when 'pricing' then 0 when 'pending' then 1 else 2 end, r.name
         limit $1`,
        [limit],
      );
      return rows.map(money);
    },

    async getPricing(mealId) {
      const { rows } = await run(pool, 'select * from pricings where meal_id = $1', [mealId]);
      if (!rows[0]) return null;
      const [recipe, steps] = await Promise.all([
        run(pool, 'select name, image_url, est_servings, ingredients, source_url from recipes where meal_id = $1 order by created_at limit 1', [mealId]),
        run(pool, 'select id, attempt, at, kind, tool, input, output, text from pricer_steps where meal_id = $1 order by id', [mealId]),
      ]);
      const { messages, ...pricing } = money(rows[0]);
      return { ...pricing, recipe: recipe.rows[0] ?? null, steps: steps.rows };
    },

    // Clears every price: recipes wait, unqueued, until someone asks for them.
    async clearPricings() {
      await run(pool, 'delete from pricer_steps');
      const { rowCount } = await run(
        pool,
        `update pricings set status = 'unpriced', attempts = 0, claimed_at = null, finished_at = null, error = null, summary = null,
           basket = '[]'::jsonb, total_cost_usd = null, to_buy_usd = null, nutrition_total = null, tool_calls = 0, messages = null,
           people = null, prompt = null, updated_at = now()`,
      );
      return rowCount;
    },

    // Ready-made prices for the sample database: one estimated line per recipe,
    // so the Pricer leaves them alone and the Meal Planners can work at once.
    async setSamplePrices(entries) {
      for (const e of entries) {
        await run(
          pool,
          `update pricings set status = 'priced', attempts = 0, claimed_at = null, finished_at = now(), error = null, summary = $2,
             basket = $3, total_cost_usd = $4, to_buy_usd = $4, nutrition_total = null, tool_calls = 0, messages = null,
             people = $5, prompt = null, updated_at = now()
           where meal_id = $1`,
          [e.meal_id, e.summary, JSON.stringify(e.basket), e.total, e.people],
        );
      }
    },

    // Queues every recipe that has no price (cleared, or couldn't be priced).
    async queueUnpriced() {
      const { rows } = await run(pool, "select meal_id from pricings where status in ('unpriced', 'failed')");
      if (!rows.length) return 0;
      await run(pool, "delete from pricer_steps where meal_id = any($1)", [rows.map((r) => r.meal_id)]);
      await run(
        pool,
        `update pricings set status = 'pending', attempts = 0, claimed_at = null, error = null, basket = '[]'::jsonb, tool_calls = 0,
           messages = null, created_at = now(), updated_at = now()
         where meal_id = any($1)`,
        [rows.map((r) => r.meal_id)],
      );
      return rows.length;
    },

    // The agent's latest steps across all recipes, newest first.
    async recentPricerSteps(limit = 40) {
      const { rows } = await run(
        pool,
        `select s.id, s.meal_id, s.at, s.kind, s.tool, s.input, s.output, s.text, r.name
         from pricer_steps s
         left join lateral (select name from recipes where meal_id = s.meal_id order by created_at limit 1) r on true
         order by s.id desc limit $1`,
        [limit],
      );
      return rows;
    },

    async recentPricerTests(minutes) {
      const { rows } = await run(
        pool,
        `select count(*)::int as n, count(*) filter (where status = 'running' and updated_at > now() - interval '5 minutes')::int as running
         from pricer_tests where created_at > now() - make_interval(mins => $1)`,
        [minutes],
      );
      return rows[0];
    },

    // Admin: price again from scratch (all failed ones, or everything).
    async resetPricings({ onlyFailed }) {
      const where = onlyFailed ? "where status = 'failed'" : '';
      const { rows } = await run(pool, `select meal_id from pricings ${where}`);
      const ids = rows.map((r) => r.meal_id);
      if (!ids.length) return 0;
      await run(pool, 'delete from pricer_steps where meal_id = any($1)', [ids]);
      await run(
        pool,
        `update pricings set status = 'pending', attempts = 0, claimed_at = null, finished_at = null, error = null, summary = null,
           basket = '[]'::jsonb, total_cost_usd = null, to_buy_usd = null, nutrition_total = null, tool_calls = 0, messages = null,
           people = null, prompt = null, created_at = now(), updated_at = now()
         where meal_id = any($1)`,
        [ids],
      );
      return ids.length;
    },

    // ------------------------------------------------------------ backup agent runs
    // A run still "running" after 6 minutes was cut off by the server (functions stop after 5).
    async createBackupRun({ agent, group_name, input }) {
      await run(pool, "update backup_runs set status = 'failed', outcome = 'Run failed', summary = 'The server stopped the run before it finished.', finished_at = now() where status = 'running' and created_at < now() - interval '6 minutes'");
      const busy = await run(pool, "select id from backup_runs where agent = $1 and status = 'running' limit 1", [agent]);
      if (busy.rows[0]) return { busy: busy.rows[0].id };
      await run(pool, 'delete from backup_runs where id not in (select id from backup_runs order by created_at desc limit 49)');
      const { rows } = await run(pool, 'insert into backup_runs (agent, group_name, input) values ($1, $2, $3) returning id', [agent, group_name, JSON.stringify(input)]);
      return { id: rows[0].id };
    },
    async addBackupStep(id, step, actions) {
      await run(pool, 'update backup_runs set steps = steps || $2::jsonb, actions = $3 where id = $1', [id, JSON.stringify([step]), actions]);
    },
    async finishBackupRun(id, { status, outcome, summary }) {
      await run(pool, 'update backup_runs set status = $2, outcome = $3, summary = $4, finished_at = now() where id = $1', [id, status, outcome, summary]);
    },
    async getBackupRun(id) {
      const { rows } = await run(pool, 'select * from backup_runs where id = $1', [id]);
      return rows[0] ?? null;
    },
    async latestAgentRun(agent) {
      const { rows } = await run(pool, 'select * from backup_runs where agent = $1 order by created_at desc limit 1', [agent]);
      return rows[0] ?? null;
    },
    async listBackupRuns(limit = 20) {
      const { rows } = await run(pool, 'select id, agent, group_name, input, status, outcome, summary, actions, created_at, finished_at from backup_runs order by created_at desc limit $1', [limit]);
      return rows;
    },

    // ------------------------------------------------------------ Pricer test runs
    async createPricerTest({ name, ingredients, serves, prompt, draft }) {
      // Keep the last 20 test runs.
      await run(pool, 'delete from pricer_tests where id not in (select id from pricer_tests order by created_at desc limit 19)');
      const { rows } = await run(
        pool,
        'insert into pricer_tests (name, ingredients, serves, prompt, draft) values ($1, $2, $3, $4, $5) returning *',
        [name, JSON.stringify(ingredients), serves, prompt, draft],
      );
      return rows[0];
    },

    async addPricerTestStep(id, step) {
      await run(pool, 'update pricer_tests set steps = steps || $2::jsonb, updated_at = now() where id = $1', [id, JSON.stringify([step])]);
    },

    async updatePricerTest(id, fields) {
      const allowed = ['status', 'basket', 'totals', 'people', 'summary', 'error', 'tool_calls'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) return;
      const json = new Set(['basket', 'totals']);
      const sets = keys.map((k, i) => `${k} = $${i + 2}${json.has(k) ? '::jsonb' : ''}`).join(', ');
      await run(pool, `update pricer_tests set ${sets}, updated_at = now() where id = $1`, [id, ...keys.map((k) => (json.has(k) ? JSON.stringify(fields[k]) : fields[k]))]);
    },

    // The test run with this id, or the latest one. A run that stopped
    // answering for 5 minutes is reported as failed.
    async getPricerTest(id) {
      const { rows } = id
        ? await run(pool, 'select * from pricer_tests where id = $1', [id])
        : await run(pool, 'select * from pricer_tests order by created_at desc limit 1');
      const t = rows[0];
      if (t && t.status === 'running' && Date.now() - new Date(t.updated_at).getTime() > 5 * 60_000) {
        return { ...t, status: 'failed', error: 'The test stopped without finishing (the server cut it short). Try again.' };
      }
      return t ?? null;
    },

    // ------------------------------------------------------------ edited sample prompts
    async listPromptDefaults(agent) {
      const { rows } = await run(pool, 'select step, text, updated_at from prompt_defaults where agent = $1 order by step', [agent]);
      return rows;
    },
    async setPromptDefault(agent, step, text) {
      if (text == null) return run(pool, 'delete from prompt_defaults where agent = $1 and step = $2', [agent, step]);
      await run(
        pool,
        `insert into prompt_defaults (agent, step, text) values ($1, $2, $3)
         on conflict (agent, step) do update set text = excluded.text, updated_at = now()`,
        [agent, step, text],
      );
    },

    async listPromptOverrides(agent) {
      const { rows } = await run(pool, 'select step, text, updated_at from prompt_overrides where agent = $1 order by step', [agent]);
      return rows;
    },

    async setPromptOverride(agent, step, text) {
      if (text == null) {
        await run(pool, 'delete from prompt_overrides where agent = $1 and step = $2', [agent, step]);
        return;
      }
      await run(
        pool,
        `insert into prompt_overrides (agent, step, text) values ($1, $2, $3)
         on conflict (agent, step) do update set text = excluded.text, updated_at = now()`,
        [agent, step, text],
      );
    },

    async cacheGet(key, maxAgeSeconds) {
      const { rows } = await run(pool, 'select data from pricer_cache where key = $1 and at > now() - make_interval(secs => $2)', [key, maxAgeSeconds]);
      return rows[0]?.data ?? null;
    },

    async cacheSet(key, data) {
      await run(
        pool,
        'insert into pricer_cache (key, data) values ($1, $2) on conflict (key) do update set data = excluded.data, at = now()',
        [key, JSON.stringify(data)],
      );
    },

    async tablesExist() {
      const { rows } = await pool.query(
        "select to_regclass('public.recipes') is not null and to_regclass('public.activity') is not null and to_regclass('public.plans') is not null as ok",
      );
      return rows[0].ok;
    },
  };
}
