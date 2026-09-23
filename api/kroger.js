// Kroger lookups through the coordinator's credentials (group key required).
//
//   GET /api/kroger/stores?zip=45202
//   GET /api/kroger/products?term=yellow%20onions&store_id=01400943&limit=5
//
// vercel.json rewrites /api/kroger/{what} to this function with ?what=.
import { findStores, searchProducts } from '../lib/kroger.js';
import { json, guarded, requireGroup } from '../lib/http.js';

export const GET = guarded(async (request) => {
  const { response } = await requireGroup(request);
  if (response) return response;
  const url = new URL(request.url);
  const what = url.searchParams.get('what') || url.pathname.match(/\/api\/kroger\/([a-z]+)/)?.[1];
  const params = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'what'));
  const res = what === 'stores' ? await findStores(params) : what === 'products' ? await searchProducts(params) : null;
  if (!res) return json(404, { errors: ['Use /api/kroger/stores?zip=… or /api/kroger/products?term=…&store_id=…'] });
  const { ok, status, errors, ...body } = res;
  return ok ? json(200, body) : json(status, { errors });
});
