// Setup check used by the site footer, the Database page and the Admin page:
// is a database connected, do the tables exist, are the keys set?
// Reports yes/no only, never the values.
import { getStore, databaseConnected, NOT_CONNECTED } from '../lib/store/index.js';
import { TABLES_MISSING } from '../lib/store/errors.js';
import { classKeySet } from '../lib/auth.js';
import { adminKeySet } from '../lib/admin.js';
import { krogerConfigured } from '../lib/kroger.js';
import { pricerSettings } from '../lib/pricer.js';
import { usdaKey } from '../lib/usda.js';
import { json } from '../lib/http.js';

export async function GET() {
  const problems = [];
  if (!classKeySet()) {
    problems.push('CLASS_KEY is not set: add it in Vercel (Settings → Environment Variables), then redeploy. Changes only take effect in new deployments.');
  }

  let database = 'not connected';
  if (!databaseConnected()) {
    problems.push(NOT_CONNECTED);
  } else {
    try {
      if (await getStore().tablesExist()) database = 'ready';
      else {
        database = 'no tables';
        problems.push(TABLES_MISSING);
      }
    } catch (e) {
      database = 'unreachable';
      problems.push(`Can't reach the database: ${e.message}`);
    }
  }

  const warnings = [];
  if (!krogerConfigured()) warnings.push('Kroger prices are off: add KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in Vercel, then redeploy. The Meal Planner needs them.');
  if (!adminKeySet()) warnings.push('The Admin page is off: add ADMIN_KEY in Vercel, then redeploy.');
  const pricer = pricerSettings();
  if (!pricer.aiKey) warnings.push('The Pricer agent is off: add ANTHROPIC_API_KEY in Vercel, then redeploy.');
  if (!usdaKey()) warnings.push('The Meal Planner’s nutrition lookups (search_foods) use USDA’s shared DEMO_KEY, which runs out quickly: add USDA_API_KEY (free from api.data.gov) in Vercel.');

  return json(problems.length ? 503 : 200, {
    ok: problems.length === 0,
    database,
    class_key: classKeySet(),
    admin_key: adminKeySet(),
    kroger: krogerConfigured(),
    pricer: Boolean(pricer.aiKey),
    usda_key: Boolean(usdaKey()),
    problems,
    warnings,
  });
}
