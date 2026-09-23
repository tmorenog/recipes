// Group keys. One environment variable lists every group and its key:
//   GROUP_KEYS=team-1:k3y-one,team-2:k3y-two
// A request is from a group if it sends that group's key:
//   Authorization: Bearer k3y-one
import { timingSafeEqual } from 'node:crypto';

export function parseGroupKeys(raw = process.env.GROUP_KEYS) {
  const groups = [];
  const problems = [];
  for (const entry of (raw || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    const name = i > 0 ? entry.slice(0, i).trim() : '';
    const key = i > 0 ? entry.slice(i + 1).trim() : '';
    if (!name || !key) problems.push(`"${entry.slice(0, 20)}…" should look like group-name:key`);
    else if (key.length < 8) problems.push(`the key for "${name}" is shorter than 8 characters`);
    else if (groups.some((g) => g.name === name)) problems.push(`"${name}" is listed twice`);
    else if (groups.some((g) => g.key === key)) problems.push(`"${name}" has the same key as another group`);
    else groups.push({ name, key });
  }
  return { groups, problems };
}

const same = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Returns the group name, or null if the key is missing or wrong.
export function groupFromRequest(request) {
  const header = request.headers.get('authorization') || '';
  const key = header.replace(/^Bearer\s+/i, '').trim();
  if (!key) return null;
  const match = parseGroupKeys().groups.find((g) => same(g.key, key));
  return match ? match.name : null;
}

export function unauthorized() {
  const configured = parseGroupKeys().groups.length > 0;
  return {
    status: configured ? 401 : 503,
    error: configured
      ? 'Missing or wrong group key. Send the header "Authorization: Bearer <your group key>".'
      : 'No group keys are set up yet: add GROUP_KEYS in Vercel (Settings → Environment Variables) and redeploy.',
  };
}
