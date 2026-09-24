// Recipes, meal plans and the activity log, stored in Postgres.
import pg from 'pg';
import { poolConfig } from '../db.js';
import { StoreError, TABLES_MISSING } from './errors.js';

const COLUMNS = `id, group_name, theme, meal_id, name, category, cuisine, ingredients, instructions,
  est_minutes, est_servings, image_url, source_url, why_chosen, status, created_at, processed_at, processed_by`;

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

    async insertRecipe(r) {
      try {
        const { rows } = await run(
          pool,
          `insert into recipes (group_name, theme, meal_id, name, category, cuisine, ingredients, instructions,
             est_minutes, est_servings, image_url, source_url, why_chosen)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning ${COLUMNS}`,
          [r.group_name, r.theme, r.meal_id, r.name, r.category, r.cuisine, JSON.stringify(r.ingredients),
            r.instructions, r.est_minutes, r.est_servings, r.image_url, r.source_url, r.why_chosen],
        );
        return { row: rows[0] };
      } catch (e) {
        if (e.code === '23505') return { duplicate: true };
        throw e;
      }
    },

    async listRecipes({ status, theme, group, limit }) {
      const where = [];
      const params = [];
      if (status !== 'all') where.push(`status = $${params.push(status)}`);
      if (theme) where.push(`theme = $${params.push(theme)}`);
      if (group) where.push(`group_name = $${params.push(group)}`);
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
      const { rows } = await run(pool, 'select id, meal_id, name, cuisine, category, image_url, status from recipes where id = any($1::uuid[])', [ids]);
      return new Map(rows.map((r) => [r.id, r]));
    },

    async recipeStatuses(ids) {
      const { rows } = await run(pool, 'select id, status from recipes where id = any($1::uuid[])', [ids]);
      return new Map(rows.map((r) => [r.id, r.status]));
    },

    async insertPlan(p) {
      const { rows } = await run(
        pool,
        `insert into plans (group_name, summary, budget_usd, total_cost_usd, store_id, meals, shopping_list, rule_checks)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [p.group_name, p.summary, p.budget_usd, p.total_cost_usd, p.store_id, JSON.stringify(p.meals),
          JSON.stringify(p.shopping_list), JSON.stringify(p.rule_checks)],
      );
      return numbers(rows[0]);
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

    async logActivity(e) {
      try {
        await pool.query(
          'insert into activity (group_name, channel, action, ok, detail, input) values ($1, $2, $3, $4, $5, $6)',
          [e.group_name, e.channel, e.action, e.ok, e.detail, e.input == null ? null : JSON.stringify(e.input)],
        );
      } catch (err) {
        console.error('activity log failed:', err.message); // logging must never break a request
      }
    },

    // ---- admin
    async updateRecipe(id, fields) {
      const cols = Object.keys(fields);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const values = cols.map((c) => (c === 'ingredients' ? JSON.stringify(fields[c]) : fields[c]));
      try {
        const { rows } = await run(pool, `update recipes set ${sets} where id = $1 returning ${COLUMNS}`, [id, ...values]);
        return { row: rows[0] ?? null };
      } catch (e) {
        if (e.code === '23505') return { duplicate: true };
        throw e;
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
        await client.query('delete from activity; delete from plans; delete from recipes; delete from pricer_steps; delete from pricings;');
        for (const r of recipes) {
          await client.query(
            `insert into recipes (id, group_name, theme, meal_id, name, category, cuisine, ingredients, instructions, est_minutes,
               est_servings, image_url, source_url, why_chosen, status, created_at, processed_at, processed_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [r.id, r.group_name, r.theme, r.meal_id, r.name, r.category ?? null, r.cuisine ?? null, JSON.stringify(r.ingredients), r.instructions,
              r.est_minutes, r.est_servings, r.image_url ?? null, r.source_url ?? null, r.why_chosen, r.status, r.created_at, r.processed_at ?? null, r.processed_by ?? null],
          );
        }
        for (const p of plans) {
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
    async enqueuePricing(mealId) {
      await run(pool, 'insert into pricings (meal_id) values ($1) on conflict do nothing', [mealId]);
    },

    // Takes the next recipe waiting to be priced, or one whose run stopped
    // without finishing (claimed more than staleSeconds ago). At most maxActive
    // run at once. Returns the pricing with its recipe, or null.
    async claimPricing({ maxActive = 2, staleSeconds = 300, maxAttempts = 3 } = {}) {
      const client = await pool.connect();
      try {
        await client.query('begin');
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
          `update pricings set status = 'pricing', claimed_at = now(), attempts = attempts + 1, updated_at = now()
           where meal_id = (
             select meal_id from pricings
             where status = 'pending' or (status = 'pricing' and claimed_at < now() - make_interval(secs => $1))
             order by created_at limit 1 for update skip locked)
           returning *`,
          [staleSeconds],
        );
        await client.query('commit');
        if (!rows[0]) return null;
        const recipe = await run(
          pool,
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

    async savePricingProgress(mealId, { messages, basket, toolCalls, storeId }) {
      await run(
        pool,
        `update pricings set messages = $2, basket = $3, tool_calls = $4, store_id = coalesce($5, store_id), claimed_at = now(), updated_at = now()
         where meal_id = $1`,
        [mealId, JSON.stringify(messages), JSON.stringify(basket), toolCalls, storeId ?? null],
      );
    },

    async finishPricing(mealId, { status, error = null, summary = null, people = null, prompt = null, basket, total, toBuy, nutrition }) {
      await run(
        pool,
        `update pricings set status = $2, error = $3, summary = $4, basket = coalesce($5, basket), total_cost_usd = $6, to_buy_usd = $7,
           nutrition_total = $8, people = $9, prompt = coalesce($10, prompt), finished_at = now(), updated_at = now(), messages = null
         where meal_id = $1`,
        [mealId, status, error, summary, basket ? JSON.stringify(basket) : null, total ?? null, toBuy ?? null,
          nutrition ? JSON.stringify(nutrition) : null, people, prompt],
      );
    },

    // A run that ran out of time hands the recipe back to the queue.
    async releasePricing(mealId) {
      await run(pool, `update pricings set status = 'pending', claimed_at = null, updated_at = now() where meal_id = $1 and status = 'pricing'`, [mealId]);
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
                p.tool_calls, p.created_at, p.updated_at, p.finished_at, jsonb_array_length(p.basket) as lines_done,
                r.name, r.image_url, r.est_servings, jsonb_array_length(r.ingredients) as lines, r.groups
         from pricings p
         left join lateral (
           select name, image_url, est_servings, ingredients, (select array_agg(distinct group_name) from recipes where meal_id = p.meal_id) as groups
           from recipes where meal_id = p.meal_id order by created_at limit 1) r on true
         order by case p.status when 'pricing' then 0 when 'pending' then 1 else 2 end, p.updated_at desc
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

    async pricingsFor(mealIds) {
      if (!mealIds.length) return new Map();
      const { rows } = await run(
        pool,
        'select meal_id, status, total_cost_usd, to_buy_usd, nutrition_total, people, error from pricings where meal_id = any($1)',
        [mealIds],
      );
      return new Map(rows.map((r) => [r.meal_id, money(r)]));
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

    // ------------------------------------------------------------ edited sample prompts
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
