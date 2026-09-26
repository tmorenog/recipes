// Kroger store and product lookups, using the instructor's Kroger developer
// credentials (KROGER_CLIENT_ID / KROGER_CLIENT_SECRET) so students need none.
// Prices only come back for a specific store, so find a store first.
import { z } from 'zod';
import { setting } from './env.js';
import { reasons } from './recipes.js';

// Kroger has a production server and a certification (test) server; a new
// app's keys may only work on one. KROGER_API_BASE picks one; otherwise
// production is tried first, then certification, and the one that signs in is used.
const SERVERS = ['https://api.kroger.com/v1', 'https://api-ce.kroger.com/v1'];
let API = SERVERS[0];
const SEARCH_TTL_MS = 60 * 60 * 1000; // prices change slowly; spare the daily quota

let token = null; // { value, expires }
const cache = new Map();

export class KrogerError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Pasted keys often carry a stray space, line break or quotes: ignore them.
const clean = (v) => (v == null ? v : String(v).trim().replace(/^(["'])(.*)\1$/, '$2').trim());
export const krogerSettings = (env = process.env) => ({
  id: clean(setting(['KROGER_CLIENT_ID'], env)),
  secret: clean(setting(['KROGER_CLIENT_SECRET'], env)),
  base: clean(setting(['KROGER_API_BASE'], env)),
});
export const krogerConfigured = () => {
  const { id, secret } = krogerSettings();
  return Boolean(id && secret);
};

async function signIn(base, id, secret, fetchImpl) {
  const res = await fetchImpl(`${base}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials&scope=product.compact',
  });
  const body = await res.json().catch(() => ({}));
  return { res, body, reason: [body.error, body.error_description].filter(Boolean).join(': ') };
}

async function accessToken(fetchImpl) {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const { id, secret, base } = krogerSettings();
  if (!id || !secret) {
    throw new KrogerError('Kroger prices are not set up yet: the instructor needs to add KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in Vercel.', 503);
  }
  const servers = base ? [base.replace(/\/$/, '')] : [API, ...SERVERS.filter((b) => b !== API)];
  const refused = [];
  for (const server of servers) {
    const { res, body, reason } = await signIn(server, id, secret, fetchImpl);
    if (res.ok && body.access_token) {
      API = server;
      token = { value: body.access_token, expires: Date.now() + (body.expires_in || 1800) * 1000 };
      return token.value;
    }
    if (res.status === 400 || res.status === 401) {
      refused.push(`${new URL(server).host} said “${reason || `HTTP ${res.status}`}”`);
      continue;
    }
    throw new KrogerError(`Kroger sign-in failed (HTTP ${res.status}). Try again in a minute.`);
  }
  const scope = refused.some((r) => /scope/i.test(r));
  throw new KrogerError(
    `Kroger rejected the coordinator’s credentials (${refused.join('; ')}). ` +
      (scope
        ? 'The app needs the Products API: add it to your app at developer.kroger.com.'
        : 'Check KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in Vercel: copy them again from your app at developer.kroger.com, with no spaces, and redeploy.'),
    503,
  );
}

// For the Admin page: signs in afresh and runs one store search.
export async function checkKroger(fetchImpl = fetch) {
  token = null;
  try {
    await accessToken(fetchImpl);
    const stores = await findStores({ zip: '45202' }, fetchImpl);
    if (!stores.ok) return { ok: false, server: API, errors: stores.errors };
    return { ok: true, server: API, stores_found: stores.count };
  } catch (e) {
    if (e instanceof KrogerError) return { ok: false, errors: [e.message] };
    throw e;
  }
}

async function get(path, fetchImpl, { ttl = SEARCH_TTL_MS, missing = false } = {}) {
  const cached = cache.get(path);
  if (cached && cached.expires > Date.now()) return cached.data;
  const bearer = await accessToken(fetchImpl); // first: signing in decides which server to use
  const res = await fetchImpl(`${API}${path}`, {
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
  });
  if (res.status === 401) token = null; // expired early: the next call signs in again
  if (res.status === 429) throw new KrogerError('Kroger is limiting requests right now. Wait a minute and try again, and reuse prices you already have.', 429);
  if (missing && (res.status === 404 || res.status === 400)) return null; // no such product (at this store)
  if (!res.ok) throw new KrogerError(`Kroger answered HTTP ${res.status}. Try again in a minute.`);
  const data = await res.json();
  cache.set(path, { data, expires: Date.now() + ttl });
  return data;
}

export const storesSchema = z.strictObject({
  zip: z.string().trim().regex(/^\d{5}$/, 'must be a 5-digit US ZIP code').describe('US ZIP code, e.g. "45202"'),
});

export const productsSchema = z.strictObject({
  term: z.string().trim().min(2).max(100).describe('What to search for, e.g. "yellow onions"'),
  store_id: z.string().trim().regex(/^[0-9A-Za-z]{3,20}$/, 'must be a store_id from find_stores').describe('A store_id from find_stores'),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

const invalid = (error, input) => ({ ok: false, status: 400, errors: reasons(error, input) });
const failed = (e) => {
  if (e instanceof KrogerError) return { ok: false, status: e.status, errors: [e.message] };
  throw e;
};

export async function findStores(input, fetchImpl = fetch) {
  const parsed = storesSchema.safeParse(input ?? {});
  if (!parsed.success) return invalid(parsed.error, input);
  try {
    const data = await get(`/locations?filter.zipCode.near=${parsed.data.zip}&filter.limit=5`, fetchImpl);
    const stores = (data.data || []).map((l) => ({
      store_id: l.locationId,
      name: l.name,
      chain: l.chain,
      address: [l.address?.addressLine1, l.address?.city, [l.address?.state, l.address?.zipCode].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', '),
    }));
    return { ok: true, count: stores.length, stores };
  } catch (e) {
    return failed(e);
  }
}

const imageUrl = (p) => {
  const front = (p.images || []).find((i) => i.perspective === 'front') || (p.images || [])[0];
  const size = front?.sizes?.find((s) => s.size === 'medium') || front?.sizes?.[0];
  return size?.url || null;
};

// One Kroger product as the agents see it.
function product(p) {
  const item = (p.items || [])[0] || {};
  const regular = item.price?.regular || null;
  const promo = item.price?.promo && item.price.promo < regular ? item.price.promo : null;
  return {
    product_id: p.productId,
    description: p.description,
    brand: p.brand || null,
    size: item.size || null,
    price_usd: regular,
    promo_price_usd: promo,
    image_url: imageUrl(p),
  };
}

// A product at a store today: whether the store carries it, and today's price
// (cached for a few minutes only). Stock levels are not checked. Returns { ok, product } with product null when the
// store doesn't have it, or { ok: false, status, errors }.
export async function productAtStore({ product_id, store_id }, fetchImpl = fetch) {
  if (!/^[0-9A-Za-z-]{3,40}$/.test(product_id ?? '') || !/^[0-9A-Za-z]{3,20}$/.test(store_id ?? '')) return { ok: false, status: 400, errors: ['not a Kroger product_id or store_id'] };
  try {
    const data = await get(`/products/${product_id}?filter.locationId=${store_id}`, fetchImpl, { ttl: 5 * 60 * 1000, missing: true });
    return { ok: true, product: data?.data ? product(data.data) : null };
  } catch (e) {
    return failed(e);
  }
}

export async function searchProducts(input, fetchImpl = fetch) {
  const parsed = productsSchema.safeParse(input ?? {});
  if (!parsed.success) return invalid(parsed.error, input);
  const { term, store_id, limit } = parsed.data;
  try {
    const q = new URLSearchParams({ 'filter.term': term, 'filter.locationId': store_id, 'filter.limit': String(limit) });
    const data = await get(`/products?${q}`, fetchImpl);
    const products = (data.data || []).map(product);
    return {
      ok: true,
      count: products.length,
      products,
      note: products.some((p) => p.price_usd == null) ? 'Some products have no price at this store; skip them or try another search.' : undefined,
    };
  } catch (e) {
    return failed(e);
  }
}

// Tests reset the token and cache between cases.
export function resetKroger() {
  token = null;
  API = SERVERS[0];
  cache.clear();
}
