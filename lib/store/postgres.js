// Recipes stored in plain Postgres, for projects with a connection string
// instead of Supabase settings. The tests use this store too.
import pg from 'pg';
import { poolConfig } from '../db.js';
import { StoreError, TABLES_MISSING_POSTGRES } from './errors.js';

const COLUMNS = `id, group_name, theme, meal_id, name, category, cuisine, ingredients, instructions,
  est_minutes, est_servings, image_url, source_url, why_chosen, status, created_at, processed_at, processed_by`;

// Postgres returns numeric columns as strings; the API returns numbers.
const numbers = (p) => p && { ...p, budget_usd: p.budget_usd == null ? null : Number(p.budget_usd), total_cost_usd: Number(p.total_cost_usd) };

async function run(pool, text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    if (e.code === '42P01') throw new StoreError(TABLES_MISSING_POSTGRES);
    throw e;
  }
}

export function postgresStore(urlOrPool) {
  // Serverless functions run many small instances, so keep each pool tiny.
  const pool = typeof urlOrPool === 'string' ? new pg.Pool({ ...poolConfig(urlOrPool), max: 3, idleTimeoutMillis: 10_000 }) : urlOrPool;

  return {
    backend: 'postgres',
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

    async tablesExist() {
      const { rows } = await pool.query(
        "select to_regclass('public.recipes') is not null and to_regclass('public.activity') is not null and to_regclass('public.plans') is not null as ok",
      );
      return rows[0].ok;
    },
  };
}
