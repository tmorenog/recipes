// Kroger lookups, with Kroger's API replaced by a stub.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { findStores, searchProducts, resetKroger } from '../lib/kroger.js';
import './helpers.js';

function stubKroger({ tokenStatus = 200, productStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    const json = (status, body) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/connect/oauth2/token')) {
      return tokenStatus === 200 ? json(200, { access_token: 'tok-123', expires_in: 1800 }) : json(tokenStatus, {});
    }
    if (url.includes('/locations')) {
      return json(200, { data: [{ locationId: '01400943', name: 'Kroger Hyde Park', chain: 'KROGER', address: { addressLine1: '3760 Paxton Ave', city: 'Cincinnati', state: 'OH', zipCode: '45209' } }] });
    }
    if (url.includes('/products')) {
      if (productStatus !== 200) return json(productStatus, {});
      return json(200, {
        data: [
          { productId: '0001111060903', description: 'Yellow Onions', brand: 'Kroger', items: [{ size: '3 lb', price: { regular: 3.49, promo: 2.99 } }],
            images: [{ perspective: 'front', sizes: [{ size: 'medium', url: 'https://img/onion.jpg' }] }] },
          { productId: '2', description: 'Onion Powder', items: [{ size: '2 oz', price: { regular: 1.99, promo: 0 } }] },
          { productId: '3', description: 'Sweet Onion', items: [{ size: 'each' }] },
        ],
      });
    }
    return json(404, {});
  };
  return { fetchImpl, calls };
}

beforeEach(() => {
  resetKroger();
  process.env.KROGER_CLIENT_ID = 'client-id';
  process.env.KROGER_CLIENT_SECRET = 'client-secret';
});

test('finds stores and prices products at a store', async () => {
  const { fetchImpl, calls } = stubKroger();
  const stores = await findStores({ zip: '45209' }, fetchImpl);
  assert.deepEqual(stores.stores, [{ store_id: '01400943', name: 'Kroger Hyde Park', chain: 'KROGER', address: '3760 Paxton Ave, Cincinnati, OH 45209' }]);
  assert.equal(calls[0].auth, `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
  assert.equal(calls[1].auth, 'Bearer tok-123');

  const res = await searchProducts({ term: 'yellow onions', store_id: '01400943' }, fetchImpl);
  assert.deepEqual(res.products[0], {
    product_id: '0001111060903', description: 'Yellow Onions', brand: 'Kroger', size: '3 lb',
    price_usd: 3.49, promo_price_usd: 2.99, image_url: 'https://img/onion.jpg',
  });
  assert.equal(res.products[1].promo_price_usd, null, 'a promo of 0 means no promotion');
  assert.equal(res.products[2].price_usd, null);
  assert.match(res.note, /no price/);
  assert.match(calls[2].url, /filter\.term=yellow\+onions&filter\.locationId=01400943&filter\.limit=5/);

  // The token and the search are reused.
  await searchProducts({ term: 'yellow onions', store_id: '01400943' }, fetchImpl);
  assert.equal(calls.length, 3);
});

test('explains bad input and Kroger problems in plain words', async () => {
  const { fetchImpl } = stubKroger();
  assert.deepEqual((await findStores({ zip: 'Cincinnati' }, fetchImpl)).errors, ['zip must be a 5-digit US ZIP code']);
  assert.deepEqual((await searchProducts({ term: 'x', store_id: '0140' }, fetchImpl)).errors, ['term is too short (at least 2 characters)']);

  resetKroger();
  const rejected = await findStores({ zip: '45209' }, stubKroger({ tokenStatus: 401 }).fetchImpl);
  assert.equal(rejected.status, 503);
  assert.match(rejected.errors[0], /Check KROGER_CLIENT_ID/);

  resetKroger();
  const limited = await searchProducts({ term: 'milk', store_id: '01400943' }, stubKroger({ productStatus: 429 }).fetchImpl);
  assert.equal(limited.status, 429);

  resetKroger();
  delete process.env.KROGER_CLIENT_ID;
  const off = await findStores({ zip: '45209' }, fetchImpl);
  assert.match(off.errors[0], /not set up yet/);
});

test('uses Kroger’s certification server when the keys only work there, and says why sign-in failed', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(new URL(url).host);
    const json = (status, body) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/connect/oauth2/token')) {
      if (url.includes('api-ce.')) return json(200, { access_token: 'ce-token', expires_in: 1800 });
      return json(401, { error: 'unauthorized', error_description: 'invalid credentials' });
    }
    if (url.includes('/locations')) {
      assert.equal(init.headers.authorization, 'Bearer ce-token');
      return json(200, { data: [{ locationId: '1', name: 'Kroger', address: {} }] });
    }
    return json(404, {});
  };
  process.env.KROGER_CLIENT_ID = '  client-id\n'; // pasted with a space and a line break
  const found = await findStores({ zip: '45209' }, fetchImpl);
  assert.equal(found.ok, true);
  assert.deepEqual(seen, ['api.kroger.com', 'api-ce.kroger.com', 'api-ce.kroger.com']);

  resetKroger();
  const refusing = async (url) => new Response(JSON.stringify({ error: 'unauthorized', error_description: 'invalid credentials' }), { status: 401 });
  const res = await findStores({ zip: '45209' }, refusing);
  assert.match(res.errors[0], /api\.kroger\.com said “unauthorized: invalid credentials”; api-ce\.kroger\.com said/);
});
