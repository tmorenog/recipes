// Reads settings by name, also when Vercel added them with a custom prefix
// (e.g. STORAGE_SUPABASE_URL). An exact name wins over a prefixed one.
export function setting(names, env = process.env) {
  for (const name of names) {
    if (env[name]) return env[name];
    const prefixed = Object.keys(env).filter((k) => k.endsWith(`_${name}`) && env[k]).sort();
    if (prefixed.length) return env[prefixed[0]];
  }
  return null;
}

export const supabaseSettings = (env = process.env) => ({
  url: setting(['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'], env),
  key: setting(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'], env),
});

// Names (never values) of settings that look database-related, to explain
// what's connected when something is missing.
export function databaseSettingNames(env = process.env) {
  return Object.keys(env)
    .filter((k) => /POSTGRES|DATABASE|SUPABASE|NEON|PGHOST/i.test(k) && env[k])
    .sort();
}
