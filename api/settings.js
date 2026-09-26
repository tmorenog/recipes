// The coordinator's current limits and plan checks (set on the Admin page).
//   GET /api/settings         anyone: the Meal Planner page shows the checks from here
//   GET /api/settings?notes   anyone: the instructor's notes for the class (FAQ page)
import { getSettings } from '../lib/settings.js';
import { getStore } from '../lib/store/index.js';
import { ruleText } from '../lib/plans.js';
import { json, guarded } from '../lib/http.js';

export const GET = guarded(async (request) => {
  if (new URL(request.url).searchParams.has('notes')) return json(200, { notes: await getStore().getNotes() });
  const settings = await getSettings();
  return json(200, { settings, plan_checks: Object.values(ruleText(settings.checks)) });
});
