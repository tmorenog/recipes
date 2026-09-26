// Admin endpoints, for the Admin page. Every request needs
//   Authorization: Bearer <ADMIN_KEY>
//
//   GET  /api/admin/check                   is the admin key right?
//   GET  /api/admin/kroger-check            can the coordinator sign in to Kroger and find a store?
//   GET  /api/admin/backup                  everything, as one JSON file
//   POST /api/admin/restore                 body: a backup file; replaces everything
//   POST /api/admin/reset                   body: {"confirm": "RESET"}; deletes everything
//   GET  /api/admin/sample                  what the sample database holds
//   GET  /api/admin/settings                the coordinator's limits and checks, with the defaults
//   POST /api/admin/settings                body: fields to change, or {"reset": true}
//   POST /api/admin/load-sample             body: {"confirm": "SAMPLE", "prices": true}; replaces everything with it
//   POST /api/admin/recipe?id=…             body: fields to change
//   POST /api/admin/delete-recipe?id=…
//   POST /api/admin/delete-plan?id=…
//   POST /api/admin/clear-activity
//   POST /api/admin/clear-exchanges
//   POST /api/admin/notes                      body {"text": "…"}: the notes for the class, shown on the FAQ page
//   GET  /api/admin/agent-runs[?id=…]          the backup agents: the latest runs, or one run with every step
//   POST /api/admin/agent-runs                 start one: {"agent":"scout","group":…,"theme":…}
//                                              or {"agent":"planner","group":…,"budget_usd":…,"requirements":…,"preferences":…}
// (Vercel's plan allows 12 functions, so the backup agents live here rather than in their own.)
//
// vercel.json rewrites /api/admin/{action} to this function with ?action=.
import * as admin from '../lib/admin.js';
import { getStore } from '../lib/store/index.js';
import { json, guarded } from '../lib/http.js';
import { checkKroger } from '../lib/kroger.js';
import { getSettings, saveSettings, DEFAULTS } from '../lib/settings.js';
import { startBackupRun, getBackupRun, listBackupRuns, backupProblem, backupModel, LIMITS as AGENT_LIMITS } from '../lib/backup-agents.js';

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
  if (action === 'kroger-check') return json(200, await checkKroger());
  if (action === 'sample') return json(200, admin.sampleSummary());
  if (action === 'settings') return json(200, { settings: await getSettings(), defaults: DEFAULTS });
  if (action === 'agent-runs') {
    const { id } = route(request);
    if (!id) return json(200, { problem: backupProblem(), model: backupModel(), limits: AGENT_LIMITS, runs: await listBackupRuns() });
    const run = await getBackupRun(id);
    return run ? json(200, run) : json(404, { errors: [`no backup run has the id ${id}`] });
  }
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
    case 'load-sample': return reply(await admin.loadSample(await body()));
    case 'settings': {
      const res = await saveSettings(await body());
      if (res.ok) await admin.logAdmin('admin_settings', JSON.stringify(res.settings));
      return reply(res);
    }
    case 'recipe': return reply(await admin.updateRecipe(id, await body()));
    case 'delete-recipe': return reply(await admin.deleteRecipe(id));
    case 'delete-plan': return reply(await admin.deletePlan(id));
    case 'clear-activity': return reply(await admin.clearActivity());
    case 'clear-exchanges': return reply(await admin.clearExchanges());
    case 'notes': {
      const input = await body();
      const text = typeof input?.text === 'string' ? input.text.trim() : null;
      if (text == null) return json(400, { errors: ['send {"text": "…"} (an empty text removes the notes)'] });
      if (text.length > 10000) return json(400, { errors: ['the notes are too long (at most 10,000 characters)'] });
      const saved = await getStore().setNotes(text);
      await admin.logAdmin('admin_notes', `${text.length} characters`);
      return json(200, { ok: true, notes: saved });
    }
    case 'agent-runs': {
      const input = await body();
      if (input === undefined) return json(400, { errors: ['send the run as JSON'] });
      const res = await startBackupRun(input);
      return res.ok ? json(202, res) : json(res.status, { errors: res.errors });
    }
    default: return json(404, { errors: [`unknown admin action "${action}"`] });
  }
});
