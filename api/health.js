// Status check: is the server configured, and have the tables been created?
// Reports only yes/no and row counts, never the secrets themselves.
import { supabaseDb } from '../lib/db.js';

export const TABLES = ['recipes', 'meal_plans', 'meal_plan_items', 'shopping_list_items', 'mcp_calls'];

const isSet = (...names) => names.some((n) => Boolean(process.env[n]));

export async function GET(request, { getDb = () => supabaseDb() } = {}) {
  const settings = {
    SUPABASE_URL: isSet('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: isSet('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'),
    MCP_API_KEY: isSet('MCP_API_KEY'),
  };
  const problems = Object.entries(settings)
    .filter(([, ok]) => !ok)
    .map(([name]) => `${name} is not set in Vercel (Settings → Environment Variables), then redeploy`);

  let tables = null;
  if (settings.SUPABASE_URL && settings.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      tables = await getDb().tableStatus(TABLES);
      const missing = TABLES.filter((t) => !tables[t].ok);
      if (missing.length) {
        problems.push(
          `can't read table(s) ${missing.join(', ')}: run supabase/migrations/0001_init.sql in the Supabase SQL Editor`,
        );
      }
    } catch (e) {
      problems.push(`can't reach Supabase: ${e.message}`);
    }
  }

  const body = { ok: problems.length === 0, settings, tables, problems, mcp_endpoint: '/mcp' };
  return new Response(JSON.stringify(body, null, 2), {
    status: body.ok ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
