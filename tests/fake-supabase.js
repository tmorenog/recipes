// In-memory stand-in for the Supabase client, covering the calls the Supabase
// store makes. It returns { data, error } like the real client, with the same
// error codes for duplicates (23505) and missing tables (PGRST205).
import { randomUUID } from 'node:crypto';

const UNIQUE = { recipes: ['group_name', 'theme', 'meal_id'] };

export function fakeSupabase() {
  const tables = { recipes: [], activity: [], plans: [] };
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1) + ++clock * 1000).toISOString();

  function from(table) {
    const state = { op: 'select', filters: [], order: null, limit: null, single: false, maybe: false, head: false, values: null };
    const builder = {
      select(_cols, opts = {}) { if (state.op === 'select') state.head = Boolean(opts.head); return builder; },
      insert(values) { state.op = 'insert'; state.values = values; return builder; },
      update(values) { state.op = 'update'; state.values = values; return builder; },
      eq(col, val) { state.filters.push([col, (v) => v === val]); return builder; },
      in(col, vals) { state.filters.push([col, (v) => vals.includes(v)]); return builder; },
      order(col, { ascending = true } = {}) { state.order = [col, ascending]; return builder; },
      limit(n) { state.limit = n; return builder; },
      single() { state.single = true; return builder; },
      maybeSingle() { state.maybe = true; return builder; },
      then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject); },
    };

    function execute() {
      const rows = tables[table];
      if (!rows) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } };
      const match = (r) => state.filters.every(([c, test]) => test(r[c]));

      if (state.op === 'insert') {
        const row = { ...state.values };
        if (table === 'recipes') {
          const key = UNIQUE.recipes;
          if (rows.some((r) => key.every((k) => r[k] === row[k]))) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          Object.assign(row, { id: randomUUID(), status: 'new', created_at: now(), processed_at: null, processed_by: null });
        } else if (table === 'plans') {
          Object.assign(row, { id: randomUUID(), created_at: now() });
        } else {
          Object.assign(row, { id: rows.length + 1, at: now() });
        }
        rows.push(row);
        return { data: state.single ? { ...row } : [{ ...row }], error: null };
      }

      if (state.op === 'update') {
        const hit = rows.filter(match);
        hit.forEach((r) => Object.assign(r, state.values));
        return { data: hit.map((r) => ({ ...r })), error: null };
      }

      let out = rows.filter(match).map((r) => ({ ...r }));
      if (state.order) {
        const [col, asc] = state.order;
        out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (state.limit != null) out = out.slice(0, state.limit);
      if (state.head) return { data: null, count: out.length, error: null };
      if (state.maybe) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }

    return builder;
  }

  return {
    from,
    rows: (t) => tables[t],
    drop: (t) => { delete tables[t]; },
  };
}
