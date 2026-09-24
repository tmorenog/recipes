// Postgres connection settings, used by the store and by `npm run db:setup`.
import { setting } from './env.js';

export function databaseUrl({ direct = false, env = process.env } = {}) {
  const pooled = ['POSTGRES_URL', 'DATABASE_URL'];
  return setting(direct ? ['POSTGRES_URL_NON_POOLING', 'DATABASE_URL_UNPOOLED', ...pooled] : pooled, env);
}

// Hosted Postgres always needs TLS. Some providers sign their certificates
// with their own authority, which Node doesn't trust, and pg treats
// sslmode=require as "verify the certificate". So the connection is encrypted
// but the certificate isn't checked. Local databases use no TLS.
export function poolConfig(url) {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname) || u.searchParams.get('host')?.startsWith('/');
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat', 'supa']) u.searchParams.delete(p);
  return { connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: false } };
}
