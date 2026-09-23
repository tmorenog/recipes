// Test setup. The end-to-end tests run once per storage backend:
// - "supabase": the real Supabase store, talking to an in-memory stand-in for
//   Supabase's API (tests/fake-supabase.js). Always runs.
// - "postgres": the Postgres store against a real database. Runs only when
//   TEST_DATABASE_URL points at a Postgres you don't mind wiping, e.g.
//     TEST_DATABASE_URL=postgres://postgres@localhost:5432/recipes_test npm test
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { poolConfig } from '../lib/db.js';
import { setStore } from '../lib/store/index.js';
import { supabaseStore } from '../lib/store/supabase.js';
import { postgresStore } from '../lib/store/postgres.js';
import { fakeSupabase } from './fake-supabase.js';

export const TEST_DB = process.env.TEST_DATABASE_URL;

export const KEYS = { 'team-1': 'key-for-team-one', 'team-2': 'key-for-team-two' };
process.env.GROUP_KEYS = Object.entries(KEYS).map(([g, k]) => `${g}:${k}`).join(',');

const schema = () => readFile(new URL('../schema.sql', import.meta.url), 'utf8');
let pool;

// Each backend's fresh() empties the store and returns ways to look inside it.
export const BACKENDS = [
  {
    name: 'supabase',
    skip: false,
    async fresh() {
      const fake = fakeSupabase();
      setStore(supabaseStore({ client: fake }));
      return {
        recipes: async () => fake.rows('recipes'),
        activity: async () => fake.rows('activity'),
        dropRecipes: async () => fake.drop('recipes'),
      };
    },
  },
  {
    name: 'postgres',
    skip: TEST_DB ? false : 'set TEST_DATABASE_URL to run the Postgres tests',
    async fresh() {
      pool ??= new pg.Pool({ ...poolConfig(TEST_DB), max: 3 });
      await pool.query('drop table if exists recipes, activity cascade');
      await pool.query(await schema());
      setStore(postgresStore(pool));
      return {
        pool,
        recipes: async () => (await pool.query('select * from recipes order by created_at')).rows,
        activity: async () => (await pool.query('select * from activity order by id')).rows,
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
