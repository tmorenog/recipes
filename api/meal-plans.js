// Meal plans. Same rules as the save_meal_plan MCP tool.
//
//   GET  /api/meal-plans?group=&limit=   anyone can read
//   GET  /api/meal-plans?choice=latest   the class's plan (the Shopper Agent's choice, with its
//                                        Kroger cart) and the Shopper Agent's latest run: anyone
//   POST /api/meal-plans                 save a plan (class key + X-Group required)
//   POST /api/meal-plans?check=true      check a draft without saving it
import { savePlan, checkPlan, listPlans } from '../lib/plans.js';
import { json, guarded, requireGroup } from '../lib/http.js';
import { shopperOverview } from '../lib/shopper.js';

export const GET = guarded(async (request) => {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  if (params.choice === 'latest') return json(200, await shopperOverview());
  const res = await listPlans(params);
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
  if (new URL(request.url).searchParams.get('check') === 'true') {
    const res = await checkPlan(input);
    if (!res.ok) return json(res.status, { errors: res.errors });
    const { ok, ...result } = res;
    return json(200, result);
  }
  const res = await savePlan({ group, channel: 'rest', input });
  if (!res.ok) return json(res.status, { errors: res.errors });
  const { ok, ...result } = res;
  return json(201, { saved: true, ...result });
});
