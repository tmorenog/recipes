// Reads settings by name, also when Vercel added them with a custom prefix
// (e.g. STORAGE_DATABASE_URL). An exact name wins over a prefixed one.
export function setting(names, env = process.env) {
  for (const name of names) {
    if (env[name]) return env[name];
    const prefixed = Object.keys(env).filter((k) => k.endsWith(`_${name}`) && env[k]).sort();
    if (prefixed.length) return env[prefixed[0]];
  }
  return null;
}
