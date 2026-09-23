// Every save and mark attempt, accepted or rejected, newest first.
//   GET /api/activity?group=&result=all|accepted|rejected&limit=
import { listActivity } from '../lib/plans.js';
import { json, guarded } from '../lib/http.js';

export const GET = guarded(async (request) => {
  const res = await listActivity(Object.fromEntries(new URL(request.url).searchParams));
  return res.ok ? json(200, { count: res.count, activity: res.activity }) : json(res.status, { errors: res.errors });
});
