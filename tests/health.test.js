import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET, TABLES } from '../api/health.js';

const VARS = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'MCP_API_KEY'];
const withEnv = async (env, fn) => {
  const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  VARS.forEach((v) => delete process.env[v]);
  Object.assign(process.env, env);
  try { return await fn(); } finally { VARS.forEach((v) => (saved[v] === undefined ? delete process.env[v] : (process.env[v] = saved[v]))); }
};
const allTables = (ok) => async () => Object.fromEntries(TABLES.map((t) => [t, ok(t) ? { ok: true, rows: 0 } : { ok: false, error: 'missing' }]));

test('health names each missing setting', async () => {
  await withEnv({}, async () => {
    const res = await GET(new Request('http://x/api/health'));
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.problems.length, 3);
    assert.match(body.problems.join(' '), /MCP_API_KEY/);
  });
});

test('health says to run the migration when tables are missing', async () => {
  const env = { SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', MCP_API_KEY: 'm' };
  await withEnv(env, async () => {
    const res = await GET(new Request('http://x/api/health'), { getDb: () => ({ tableStatus: allTables((t) => t === 'recipes') }) });
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.problems[0], /meal_plans.*0001_init\.sql/);
  });
});

test('health is ok when configured and tables exist, without leaking secrets', async () => {
  const env = { SUPABASE_URL: 'u', SUPABASE_SECRET_KEY: 'very-secret', MCP_API_KEY: 'also-secret' };
  await withEnv(env, async () => {
    const res = await GET(new Request('http://x/api/health'), { getDb: () => ({ tableStatus: allTables(() => true) }) });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(text).ok, true);
    assert.doesNotMatch(text, /secret/);
  });
});
