// Tells a group whether its key works:  GET /api/whoami  with  Authorization: Bearer <key>
import { json, requireGroup } from '../lib/http.js';

export async function GET(request) {
  const { group, response } = await requireGroup(request);
  return response ?? json(200, { group });
}

// The Welcome page's key check sends the key from the browser, so answer its preflight.
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET',
      'access-control-allow-headers': 'authorization',
      'access-control-max-age': '600',
    },
  });
}
