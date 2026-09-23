// Who is calling. The whole class shares one key (CLASS_KEY), and each group
// says which group it is with a header:
//   Authorization: Bearer <class key>
//   X-Group: team-3
import { timingSafeEqual } from 'node:crypto';

export const classKeySet = () => Boolean(process.env.CLASS_KEY?.trim());

const same = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Group names are stored lowercase with dashes, so "Team 3" and "team-3" are the same group.
export function normalizeGroup(raw) {
  const name = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) ? name : null;
}

// Returns { group } (group is null when not required and not sent),
// or { status, error } explaining what's wrong.
export function checkCaller(request, { needGroup = true } = {}) {
  if (!classKeySet()) {
    return { status: 503, error: 'The class key isn’t set up yet: the instructor needs to add CLASS_KEY in Vercel (Settings → Environment Variables) and redeploy.' };
  }
  const key = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!key || !same(key, process.env.CLASS_KEY.trim())) {
    return { status: 401, error: 'Missing or wrong class key. Send the header "Authorization: Bearer <class key>".' };
  }
  const raw = request.headers.get('x-group');
  if (!raw) {
    return needGroup
      ? { status: 400, error: 'Say which group you are with the header "X-Group: <your group name>", e.g. "X-Group: team-3".' }
      : { group: null };
  }
  const group = normalizeGroup(raw);
  if (!group) {
    return { status: 400, error: 'The X-Group name must be 1 to 40 letters, numbers, dashes or underscores, e.g. "team-3".' };
  }
  return { group };
}
