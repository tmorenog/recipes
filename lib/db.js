// Postgres connection settings, used by the store and by `npm run db:setup`.
import { setting } from './env.js';

export function databaseUrl({ direct = false, env = process.env } = {}) {
  const pooled = ['POSTGRES_URL', 'DATABASE_URL'];
  return setting(direct ? ['POSTGRES_URL_NON_POOLING', 'DATABASE_URL_UNPOOLED', ...pooled] : pooled, env);
}

// Hosted Postgres always needs TLS, and the server's certificate is checked
// against Node's trusted authorities (Neon's certificates pass). A provider
// that signs with its own authority needs one of:
//   DATABASE_CA_CERT          that authority's certificate (PEM text)
//   DATABASE_SSL_NO_VERIFY=1  encrypt without checking the certificate (less safe)
// Local databases use no TLS. TLS options in the URL are replaced by these.
export function poolConfig(url, env = process.env) {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname) || u.searchParams.get('host')?.startsWith('/');
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat', 'supa']) u.searchParams.delete(p);
  if (local) return { connectionString: u.toString(), ssl: false };
  const ca = setting(['DATABASE_CA_CERT'], env)?.replace(/\\n/g, '\n');
  const noVerify = /^(1|true|yes)$/i.test(setting(['DATABASE_SSL_NO_VERIFY'], env) ?? '');
  const ssl = noVerify ? { rejectUnauthorized: false } : ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  return { connectionString: u.toString(), ssl };
}
