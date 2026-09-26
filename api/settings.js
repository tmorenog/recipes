// The coordinator's current limits and plan checks (set on the Admin page).
//   GET /api/settings   anyone: the Meal Planner page shows the checks from here
import { getSettings } from '../lib/settings.js';
import { ruleText } from '../lib/plans.js';
import { json, guarded } from '../lib/http.js';

export const GET = guarded(async () => {
  const settings = await getSettings();
  return json(200, { settings, plan_checks: Object.values(ruleText(settings.checks)) });
});
