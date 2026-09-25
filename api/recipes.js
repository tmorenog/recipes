// REST API for apps that don't speak MCP. Same data and rules as the MCP tools.
//
//   GET  /api/recipes?status=new|processed|all&theme=&group=&limit=   anyone can read
//   POST /api/recipes                    save a recipe         (class key + X-Group required)
//   POST /api/recipes/{id}/processed     mark it processed     (class key + X-Group required)
import { saveRecipe, listRecipes, markProcessed } from '../lib/recipes.js';
import { json, guarded, requireGroup } from '../lib/http.js';
import { resumePricer } from '../lib/pricer.js';

// vercel.json rewrites /api/recipes/{id}/processed to this function with ?id=
// and ?action=processed. The path is also parsed in case the original URL arrives.
function target(url) {
  const m = url.pathname.match(/^\/api\/recipes\/([^/]+)\/processed\/?$/);
  if (m) return { id: decodeURIComponent(m[1]), action: 'processed' };
  if (url.searchParams.get('action') === 'processed') return { id: url.searchParams.get('id'), action: 'processed' };
  return { action: null };
}

const fail = (res) => json(res.status, { errors: res.errors });

export const GET = guarded(async (request) => {
  const url = new URL(request.url);
  if (target(url).action) return json(405, { errors: ['Use POST to mark a recipe processed.'] }, { allow: 'POST' });
  await resumePricer(); // the Coordinator page reads here: restart the Pricer if work is waiting
  const res = await listRecipes(Object.fromEntries(url.searchParams));
  return res.ok ? json(200, { count: res.count, recipes: res.recipes }) : fail(res);
});

export const POST = guarded(async (request) => {
  const { group, response } = await requireGroup(request);
  if (response) return response;

  const { id, action } = target(new URL(request.url));
  if (action === 'processed') {
    const res = await markProcessed({ group, channel: 'rest', id });
    if (!res.ok) return fail(res);
    return json(200, { processed: true, already: res.already, recipe: res.recipe });
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json(400, { errors: ['The request body must be JSON, with the header Content-Type: application/json.'] });
  }
  const res = await saveRecipe({ group, channel: 'rest', input });
  return res.ok ? json(201, { saved: true, recipe: res.recipe, ...(res.notes?.length && { format_notes: res.notes }) }) : fail(res);
});
