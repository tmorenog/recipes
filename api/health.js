// Setup check used by the site footer and the Database page: is a database connected, do the tables
// exist, is the class key set? Shows setting names, never values.
import { getStore, configuredBackend } from '../lib/store/index.js';
import { TABLES_MISSING_SUPABASE, TABLES_MISSING_POSTGRES } from '../lib/store/errors.js';
import { databaseSettingNames } from '../lib/env.js';
import { classKeySet } from '../lib/auth.js';
import { json } from '../lib/http.js';
import { krogerConfigured } from '../lib/kroger.js';

export async function GET() {
  const problems = [];
  if (!classKeySet()) {
    problems.push('CLASS_KEY is not set: add it in Vercel (Settings → Environment Variables), then redeploy. Changes only take effect in new deployments.');
  }

  const seen = databaseSettingNames();
  const backend = configuredBackend();
  let database = 'not connected';

  if (!backend) {
    problems.push(
      seen.length
        ? `The database settings are incomplete (found ${seen.join(', ')}). Easiest fix: in Vercel, open Storage, create a Postgres database, connect it to this project, and redeploy. The tables are then created automatically.`
        : 'No database is connected: in Vercel, open Storage, create a Postgres database, connect it to this project, and redeploy. The tables are then created automatically.',
    );
  } else {
    try {
      if (await getStore().tablesExist()) {
        database = 'ready';
      } else {
        database = 'no tables';
        problems.push(backend === 'supabase' ? TABLES_MISSING_SUPABASE : TABLES_MISSING_POSTGRES);
      }
    } catch (e) {
      database = 'unreachable';
      problems.push(`Can't reach the database: ${e.message}`);
    }
  }

  const warnings = krogerConfigured()
    ? []
    : ['Kroger prices are off: add KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in Vercel, then redeploy. The Meal Planner needs them.'];

  return json(problems.length ? 503 : 200, {
    ok: problems.length === 0,
    kroger: krogerConfigured(),
    warnings,
    backend,
    database,
    database_settings_seen: seen,
    class_key: classKeySet(),
    problems,
  });
}
