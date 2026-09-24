// Test setup. The end-to-end tests need a Postgres they can wipe, named by
// TEST_DATABASE_URL, e.g.
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/recipes_test npm test
// Without it they're skipped and only the unit tests run.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { poolConfig } from '../lib/db.js';
import { setStore } from '../lib/store/index.js';
import { postgresStore } from '../lib/store/postgres.js';

export const TEST_DB = process.env.TEST_DATABASE_URL;

export const CLASS_KEY = 'class-key-for-tests';
process.env.CLASS_KEY = CLASS_KEY;
// Headers a group's agent sends.
export const as = (group) => ({ authorization: `Bearer ${CLASS_KEY}`, 'x-group': group });

const schema = () => readFile(new URL('../schema.sql', import.meta.url), 'utf8');
let pool;

// fresh() recreates the tables and returns ways to look inside them.
export const BACKENDS = [
  {
    name: 'postgres',
    skip: TEST_DB ? false : 'set TEST_DATABASE_URL to run the Postgres tests',
    async fresh() {
      pool ??= new pg.Pool({ ...poolConfig(TEST_DB), max: 3 });
      await pool.query('drop table if exists recipes, activity, plans cascade');
      await pool.query(await schema());
      setStore(postgresStore(pool));
      return {
        pool,
        recipes: async () => (await pool.query('select * from recipes order by created_at')).rows,
        activity: async () => (await pool.query('select * from activity order by id')).rows,
        plans: async () => (await pool.query('select * from plans order by created_at')).rows,
        dropRecipes: async () => pool.query('drop table recipes cascade'),
      };
    },
  },
];

export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
  setStore(undefined);
}

export function recipe(overrides = {}) {
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

// A valid 5-meal plan for the given recipe ids (costs and totals add up).
export function mealPlan(ids, overrides = {}) {
  return {
    summary: 'Five balanced vegetarian dinners under budget.',
    budget_usd: 60,
    store_id: '01400943',
    total_cost_usd: 13.47,
    meals: ids.map((recipe_id, i) => ({
      day: i + 1,
      recipe_id,
      servings: 4,
      cost_used_usd: 8,
      cost_per_serving_usd: 2,
      nutrition_per_serving: { calories: 550, protein_g: 25, fiber_g: 9, sodium_mg: 700 },
    })),
    shopping_list: [
      { item: 'chickpeas', kroger_product_id: '0001111', size: '15 oz', quantity: 3, unit_price_usd: 1.29, recipe_ids: [ids[0], ids[1]] },
      { item: 'yellow onions', size: '3 lb bag', quantity: 2, unit_price_usd: 4.8, recipe_ids: ids },
    ],
    rule_checks: [{ rule: 'at least 20 g protein per serving', passed: true }],
    ...overrides,
  };
}
