// The coordinator's exchange log, newest first, for the Coordinator page.
//   GET /api/exchanges?group=&agent=scout|planner|pricer&after=<id>&limit=
import { z } from 'zod';
import { getStore } from '../lib/store/index.js';
import { json, guarded } from '../lib/http.js';

const query = z.object({
  group: z.string().trim().min(1).max(40).optional(),
  agent: z.enum(['scout', 'planner', 'pricer', 'shopper']).optional(),
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const GET = guarded(async (request) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return json(400, { errors: ['Use ?group=, ?agent=scout|planner|pricer, ?after=<id> and ?limit=1-500.'] });
  const { group, agent, after, limit } = parsed.data;
  const exchanges = await getStore().listExchanges({ group, agent, afterId: after ?? null, limit });
  return json(200, { count: exchanges.length, exchanges });
});
