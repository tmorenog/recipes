// Test setup. Tests that need a database run only when TEST_DATABASE_URL
// points at a Postgres you don't mind wiping, e.g.
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/recipes_test npm test
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { poolConfig, setPool } from '../lib/db.js';

export const TEST_DB = process.env.TEST_DATABASE_URL;
export const skipWithoutDb = TEST_DB ? false : 'set TEST_DATABASE_URL to run database tests';

export const KEYS = { 'team-1': 'key-for-team-one', 'team-2': 'key-for-team-two' };
process.env.GROUP_KEYS = Object.entries(KEYS).map(([g, k]) => `${g}:${k}`).join(',');

let pool;

export async function freshDatabase() {
  if (!pool) {
    pool = new pg.Pool({ ...poolConfig(TEST_DB), max: 3 });
    setPool(pool);
  }
  await pool.query('drop table if exists recipes, activity cascade');
  await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  return pool;
}

export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
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
