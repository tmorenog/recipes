// Keeps secrets out of anything stored or shown: error messages from other
// services can quote a key back (e.g. a mis-pasted API key).
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys
  /(x-api-key|authorization)(["':\s]+)(bearer\s+|basic\s+)?[^\s"'\\]{8,}/gi, // header values
];
const SECRET_SETTINGS = ['ANTHROPIC_API_KEY', 'CLASS_KEY', 'ADMIN_KEY', 'KROGER_CLIENT_SECRET', 'USDA_API_KEY'];

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
