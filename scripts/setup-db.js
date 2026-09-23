// Checks the database and, where it can, creates or updates the tables.
//
//   npm run db:setup          (locally: reads .env.local, e.g. from `vercel env pull .env.local`)
//
// Vercel also runs it on every deploy (the "vercel-build" script in package.json).
//
// - With a Postgres connection string (POSTGRES_URL / DATABASE_URL) it runs
//   schema.sql itself.
// - With only Supabase's API settings it can't create tables (Supabase's API
//   doesn't allow that), so it checks they exist and, if not, explains how to
//   create them in Supabase's SQL Editor.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { databaseUrl, poolConfig } from '../lib/db.js';
import { configuredBackend, getStore } from '../lib/store/index.js';

const onVercel = Boolean(process.env.VERCEL);
// On Vercel a missing setup step shouldn't block the deploy: the site itself
// explains what's missing. Locally, fail so the command's result is clear.
const incomplete = (msg) => {
  console.warn(`⚠ ${msg}`);
  process.exit(onVercel ? 0 : 1);
};

const url = databaseUrl({ direct: true });

if (url) {
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
} else if (configuredBackend() === 'supabase') {
  try {
    if (await getStore().tablesExist()) {
      console.log('✓ Supabase is connected and the tables exist.');
    } else {
      incomplete(
        'Supabase is connected but the tables are missing. Open your project in Supabase, go to SQL Editor, ' +
          'paste the contents of schema.sql and click Run. (Supabase\'s API can\'t create tables, so this step is manual, once.)',
      );
    }
  } catch (e) {
    incomplete(`Couldn't check Supabase: ${e.message}`);
  }
} else {
  incomplete(
    'No database connected: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set. ' +
      (onVercel ? 'Connect a Supabase database to this project in Vercel Storage, then redeploy.' : 'Run `vercel env pull .env.local` first.'),
  );
}
