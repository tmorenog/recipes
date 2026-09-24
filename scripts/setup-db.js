// Creates or updates the tables from schema.sql. Safe to run any number of times.
//
//   npm run db:setup          (locally: reads .env.local, e.g. from `vercel env pull .env.local`)
//
// Vercel runs it on every deploy (the "vercel-build" script in package.json).
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { databaseUrl, poolConfig } from '../lib/db.js';

const onVercel = Boolean(process.env.VERCEL);
const url = databaseUrl({ direct: true });

if (!url) {
  const msg = 'No database connected (POSTGRES_URL / DATABASE_URL not set), so the tables were not created.';
  if (onVercel) {
    // Let the deploy finish so the site can explain what's missing.
    console.warn(`⚠ ${msg} In Vercel, open Storage, create a Neon database, connect it to this project, and redeploy.`);
    process.exit(0);
  }
  console.error(`${msg}\nRun \`vercel env pull .env.local\` first, or set POSTGRES_URL.`);
  process.exit(1);
}

const client = new pg.Client(poolConfig(url));
try {
  await client.connect();
  await client.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  const { rows } = await client.query('select count(*)::int as n from recipes');
  console.log(`✓ Database ready (${rows[0].n} recipes).`);
} catch (e) {
  console.error(`✗ Database setup failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
