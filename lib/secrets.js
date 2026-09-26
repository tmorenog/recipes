// Keeps secrets out of anything stored or shown: error messages from other
// services can quote a key back (e.g. a mis-pasted API key).
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys
  /(x-api-key|authorization)(["':\s]+)(bearer\s+|basic\s+)?[^\s"'\\]{8,}/gi, // header values
];
const SECRET_SETTINGS = ['ANTHROPIC_API_KEY', 'CLASS_KEY', 'ADMIN_KEY', 'KROGER_CLIENT_SECRET'];

export function redact(text, env = process.env) {
  if (text == null) return text;
  let out = String(text);
  for (const name of SECRET_SETTINGS) {
    const value = env[name]?.trim();
    if (value && value.length >= 8) out = out.split(value).join('[hidden]');
  }
  out = out.replace(PATTERNS[0], 'sk-ant-[hidden]');
  out = out.replace(PATTERNS[1], (_, header, sep, scheme = '') => `${header}${sep}${scheme}[hidden]`);
  return out;
}

// Field names whose values are always hidden, whatever they hold.
const SECRET_FIELD = /(api[_-]?key|secret|token|password|passwd|authorization|class[_-]?key|admin[_-]?key|credential)/i;

// The same for a whole value (a request body): every string at any depth is
// redacted, and fields named like a secret are hidden entirely.
export function redactDeep(value, env = process.env, depth = 0) {
  if (typeof value === 'string') return redact(value, env);
  if (value == null || typeof value !== 'object' || depth > 20) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, env, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_FIELD.test(k) && v != null && v !== '' ? '[hidden]' : redactDeep(v, env, depth + 1)]));
}
