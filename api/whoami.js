// Checks the class key (and, if sent, the X-Group name):  GET /api/whoami
import { json, requireGroup } from '../lib/http.js';

export async function GET(request) {
  const { group, response } = await requireGroup(request, { needGroup: false });
  return response ?? json(200, { ok: true, group });
}

// The Welcome page's key check sends the key from the browser, so answer its preflight.
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET',
      'access-control-allow-headers': 'authorization, x-group',
      'access-control-max-age': '600',
    },
  });
}
