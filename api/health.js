// Setup check used by the viewer page: is a database connected, are the tables
// there, are group keys set? Shows group names and counts, never keys.
import { databaseUrl, databaseSettingNames, query } from '../lib/db.js';
import { parseGroupKeys } from '../lib/groups.js';
import { json } from '../lib/http.js';

export async function GET() {
  const problems = [];
  const { groups, problems: keyProblems } = parseGroupKeys();
  if (!groups.length) problems.push('GROUP_KEYS is not set: add it in Vercel (Settings → Environment Variables) for Production, then redeploy. Changes only take effect in new deployments.');
  problems.push(...keyProblems.map((p) => `GROUP_KEYS: ${p}`));

  let database = 'not connected';
  const seen = databaseSettingNames();
  if (!databaseUrl()) {
    if (seen.some((n) => /SUPABASE/i.test(n))) {
      problems.push(
        `Supabase is connected (found ${seen.join(', ')}), but not its Postgres connection string. ` +
          'In Supabase, click Connect, copy the Transaction pooler connection string, put your database password in it, ' +
          'and add it in Vercel as POSTGRES_URL. Then redeploy.',
      );
    } else if (seen.length) {
      problems.push(`No Postgres connection string found. Database settings present: ${seen.join(', ')}. Add POSTGRES_URL, then redeploy.`);
    } else {
      problems.push(
        'No database is connected to this project: in Vercel, open Storage, create (or connect) a Postgres database ' +
          'for this project, then redeploy. If you connected one already, it may be attached to a different project.',
      );
    }
  } else {
    try {
      await query("select 1 from recipes limit 1");
      database = 'ready';
    } catch (e) {
      if (e.code === '42P01') {
        database = 'no tables';
        problems.push('The database has no tables yet: redeploy, or run `npm run db:setup`.');
      } else {
        database = 'unreachable';
        problems.push(`Can't reach the database: ${e.message}`);
      }
    }
  }

  return json(problems.length ? 503 : 200, {
    ok: problems.length === 0,
    database,
    database_settings_seen: seen,
    groups: groups.map((g) => g.name),
    problems,
  });
}
