// Checks the class key (and, if sent, the X-Group name):  GET /api/whoami
// The Welcome page asks from the same site, and Lovable apps from their
// backends, so no other site's pages are let in (no CORS preflight answer).
import { json, requireGroup } from '../lib/http.js';

export async function GET(request) {
  const { group, response } = await requireGroup(request, { needGroup: false });
  return response ?? json(200, { ok: true, group });
}
