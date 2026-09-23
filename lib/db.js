// Postgres connection. Works with the connection strings Vercel's database
// integrations add (Neon, Supabase, ...).
import pg from 'pg';

const POOLED = ['POSTGRES_URL', 'DATABASE_URL'];
const DIRECT = ['POSTGRES_URL_NON_POOLING', 'DATABASE_URL_UNPOOLED'];

// Finds a variable by name, also when Vercel added it with a custom prefix
// (e.g. STORAGE_POSTGRES_URL). An exact name wins over a prefixed one.
function lookup(name, env) {
  if (env[name]) return env[name];
  const prefixed = Object.keys(env).filter((k) => k.endsWith(`_${name}`) && env[k]).sort();
  return prefixed.length ? env[prefixed[0]] : null;
}

export function databaseUrl({ direct = false, env = process.env } = {}) {
  const names = direct ? [...DIRECT, ...POOLED] : POOLED;
  for (const n of names) {
    const url = lookup(n, env);
    if (url) return url;
  }
  return null;
}

// Names (never values) of settings that look database-related, to explain
// what's connected when no connection string is found.
export function databaseSettingNames(env = process.env) {
  return Object.keys(env)
    .filter((k) => /POSTGRES|DATABASE|SUPABASE|NEON|PGHOST/i.test(k) && env[k])
    .sort();
}

// Hosted Postgres always needs TLS. Some providers (Supabase) sign their
// certificates with their own authority, which Node doesn't trust, and pg
// treats sslmode=require as "verify the certificate". So the connection is
// encrypted but the certificate isn't checked. Local databases use no TLS.
export function poolConfig(url) {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname) || u.searchParams.get('host')?.startsWith('/');
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat', 'supa']) u.searchParams.delete(p);
  return { connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: false } };
}

let pool;

export function getPool() {
  if (!pool) {
    const url = databaseUrl();
    if (!url) {
      const err = new Error('No database is connected: set POSTGRES_URL or DATABASE_URL (Vercel adds it when you create the database).');
      err.status = 503;
      throw err;
    }
    // Serverless functions run many small instances, so keep each pool tiny.
    pool = new pg.Pool({ ...poolConfig(url), max: 3, idleTimeoutMillis: 10_000 });
  }
  return pool;
}

export const query = (text, params) => getPool().query(text, params);

// Tests point the app at their own database.
export function setPool(p) {
  pool = p;
}
