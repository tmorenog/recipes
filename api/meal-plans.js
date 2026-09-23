// Meal plans. Same rules as the save_meal_plan MCP tool.
//
//   GET  /api/meal-plans?group=&limit=   anyone can read
//   POST /api/meal-plans                 save a plan (class key + X-Group required)
import { savePlan, listPlans } from '../lib/plans.js';
import { json, guarded, requireGroup } from '../lib/http.js';

export const GET = guarded(async (request) => {
  const res = await listPlans(Object.fromEntries(new URL(request.url).searchParams));
  return res.ok ? json(200, { count: res.count, plans: res.plans }) : json(res.status, { errors: res.errors });
});

export const POST = guarded(async (request) => {
  const { group, response } = await requireGroup(request);
  if (response) return response;
  let input;
  try {
    input = await request.json();
  } catch {
    return json(400, { errors: ['The request body must be JSON, with the header Content-Type: application/json.'] });
  }
  const res = await savePlan({ group, channel: 'rest', input });
  if (!res.ok) return json(res.status, { errors: res.errors });
  return json(201, { saved: true, plan: res.plan, warnings: res.warnings, next_step: res.next_step });
});
