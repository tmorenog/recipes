// The instructor's backup agents (a Scout or Planner Agent run from the site).
// Every request needs Authorization: Bearer <ADMIN_KEY>.
//   GET  /api/backup            the latest runs, and whether the agents can run
//   GET  /api/backup?id=…       one run, with every step
//   POST /api/backup            {"agent":"scout","group":…,"theme":…}
//                               {"agent":"planner","group":…,"budget_usd":…,"requirements":…,"preferences":…}
import { checkAdmin } from '../lib/admin.js';
import { json, guarded } from '../lib/http.js';
import { startBackupRun, getBackupRun, listBackupRuns, backupProblem, backupModel, LIMITS } from '../lib/backup-agents.js';

const denied = (request) => {
  const auth = checkAdmin(request);
  return auth.ok ? null : json(auth.status, { errors: [auth.error] });
};

export const GET = guarded(async (request) => {
  const no = denied(request);
  if (no) return no;
  const id = new URL(request.url).searchParams.get('id');
  if (id) {
    const run = await getBackupRun(id);
    return run ? json(200, run) : json(404, { errors: [`no backup run has the id ${id}`] });
  }
  return json(200, { problem: backupProblem(), model: backupModel(), limits: LIMITS, runs: await listBackupRuns() });
});

export const POST = guarded(async (request) => {
  const no = denied(request);
  if (no) return no;
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { errors: ['send the run as JSON'] });
  }
  const res = await startBackupRun(body);
  return res.ok ? json(202, res) : json(res.status, { errors: res.errors });
});
