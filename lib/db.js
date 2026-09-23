// Postgres connection. Works with the connection strings Vercel's database
// integrations add (Neon, Supabase, ...).
import pg from 'pg';

export function databaseUrl({ direct = false } = {}) {
  const names = direct
    ? ['POSTGRES_URL_NON_POOLING', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL', 'DATABASE_URL']
    : ['POSTGRES_URL', 'DATABASE_URL'];
  return names.map((n) => process.env[n]).find(Boolean) || null;
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
