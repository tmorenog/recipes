// Admin endpoints, for the Admin page. Every request needs
//   Authorization: Bearer <ADMIN_KEY>
//
//   GET  /api/admin/check                   is the admin key right?
//   GET  /api/admin/backup                  everything, as one JSON file
//   POST /api/admin/restore                 body: a backup file; replaces everything
//   POST /api/admin/reset                   body: {"confirm": "RESET"}; deletes everything
//   POST /api/admin/recipe?id=…             body: fields to change
//   POST /api/admin/delete-recipe?id=…
//   POST /api/admin/delete-plan?id=…
//   POST /api/admin/clear-activity
//
// vercel.json rewrites /api/admin/{action} to this function with ?action=.
import * as admin from '../lib/admin.js';
import { json, guarded } from '../lib/http.js';

function route(request) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || url.pathname.match(/\/api\/admin\/([a-z-]+)/)?.[1] || '';
  return { action, id: url.searchParams.get('id') };
}

const reply = (res, status = 200) => (res.ok ? json(status, res) : json(res.status, { errors: res.errors }));
const denied = (request) => {
  const auth = admin.checkAdmin(request);
  return auth.ok ? null : json(auth.status, { errors: [auth.error] });
};

export const GET = guarded(async (request) => {
  const no = denied(request);
  if (no) return no;
  const { action } = route(request);
  if (action === 'check') return json(200, { ok: true });
  if (action === 'backup') {
    const data = await admin.backup();
    const stamp = data.exported_at.slice(0, 16).replace(/[:T]/g, '-');
    return json(200, data, { 'content-disposition': `attachment; filename="recipes-backup-${stamp}.json"` });
  }
  return json(404, { errors: [`unknown admin action "${action}"`] });
});

export const POST = guarded(async (request) => {
  const no = denied(request);
  if (no) return no;
  const { action, id } = route(request);
  const body = async () => {
    try {
      return await request.json();
    } catch {
      return undefined;
    }
  };
  switch (action) {
    case 'restore': {
      const input = await body();
      if (input === undefined) return json(400, { errors: ['the backup must be sent as JSON'] });
      return reply(await admin.restore(input));
    }
    case 'reset': return reply(await admin.reset(await body()));
    case 'recipe': return reply(await admin.updateRecipe(id, await body()));
    case 'delete-recipe': return reply(await admin.deleteRecipe(id));
    case 'delete-plan': return reply(await admin.deletePlan(id));
    case 'clear-activity': return reply(await admin.clearActivity());
    default: return json(404, { errors: [`unknown admin action "${action}"`] });
  }
});
