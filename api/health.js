// Setup check used by the viewer page: is a database connected, are the tables
// there, are group keys set? Shows group names and counts, never keys.
import { databaseUrl, query } from '../lib/db.js';
import { parseGroupKeys } from '../lib/groups.js';
import { json } from '../lib/http.js';

export async function GET() {
  const problems = [];
  const { groups, problems: keyProblems } = parseGroupKeys();
  if (!groups.length) problems.push('Add GROUP_KEYS in Vercel (Settings → Environment Variables), then redeploy.');
  problems.push(...keyProblems.map((p) => `GROUP_KEYS: ${p}`));

  let database = 'not connected';
  if (!databaseUrl()) {
    problems.push('No database is connected: create a Postgres database in Vercel (Storage) and connect it to this project.');
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
    groups: groups.map((g) => g.name),
    problems,
  });
}
