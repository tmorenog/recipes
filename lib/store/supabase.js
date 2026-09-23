// Recipes stored in Supabase, through its API. Uses the service role key, so
// this must only ever run on the server.
import { createClient } from '@supabase/supabase-js';
import { StoreError, TABLES_MISSING_SUPABASE } from './errors.js';

const COLUMNS =
  'id, group_name, theme, meal_id, name, category, cuisine, ingredients, instructions, est_minutes, ' +
  'est_servings, image_url, source_url, why_chosen, status, created_at, processed_at, processed_by';

// "relation does not exist" from Postgres, or "table not in schema cache" from
// Supabase's API layer: either way the tables haven't been created.
const MISSING_TABLE = new Set(['42P01', 'PGRST205', 'PGRST204']);
const DUPLICATE = '23505';

function fail(error) {
  if (MISSING_TABLE.has(error.code)) throw new StoreError(TABLES_MISSING_SUPABASE);
  throw new StoreError(`Supabase error: ${error.message || error.code}`, 500);
}

export function supabaseStore({ url, key, client }) {
  const sb = client ?? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  return {
    backend: 'supabase',

    async insertRecipe(row) {
      const { data, error } = await sb.from('recipes').insert(row).select(COLUMNS).single();
      if (error?.code === DUPLICATE) return { duplicate: true };
      if (error) fail(error);
      return { row: data };
    },

    async listRecipes({ status, theme, group, limit }) {
      let q = sb.from('recipes').select(COLUMNS);
      if (status !== 'all') q = q.eq('status', status);
      if (theme) q = q.eq('theme', theme);
      if (group) q = q.eq('group_name', group);
      const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
      if (error) fail(error);
      return data;
    },

    async markProcessed(id, group) {
      const { data, error } = await sb
        .from('recipes')
        .update({ status: 'processed', processed_at: new Date().toISOString(), processed_by: group })
        .eq('id', id)
        .eq('status', 'new')
        .select(COLUMNS);
      if (error) fail(error);
      return data[0] ?? null;
    },

    async getRecipe(id) {
      const { data, error } = await sb.from('recipes').select(COLUMNS).eq('id', id).maybeSingle();
      if (error) fail(error);
      return data;
    },

    async recipeStatuses(ids) {
      const { data, error } = await sb.from('recipes').select('id, status').in('id', ids);
      if (error) fail(error);
      return new Map(data.map((r) => [r.id, r.status]));
    },

    async insertPlan(row) {
      const { data, error } = await sb.from('plans').insert(row).select('*').single();
      if (error) fail(error);
      return data;
    },

    async listPlans({ group, limit }) {
      let q = sb.from('plans').select('*');
      if (group) q = q.eq('group_name', group);
      const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
      if (error) fail(error);
      return data;
    },

    async listActivity({ group, ok, limit }) {
      let q = sb.from('activity').select('*');
      if (group) q = q.eq('group_name', group);
      if (ok !== undefined) q = q.eq('ok', ok);
      const { data, error } = await q.order('at', { ascending: false }).limit(limit);
      if (error) fail(error);
      return data;
    },

    async logActivity(entry) {
      const { error } = await sb.from('activity').insert(entry);
      if (error) console.error('activity log failed:', error.message); // logging must never break a request
    },

    async tablesExist() {
      for (const table of ['recipes', 'activity', 'plans']) {
        const { error } = await sb.from(table).select('*', { head: true, count: 'exact' }).limit(1);
        if (error && MISSING_TABLE.has(error.code)) return false;
        if (error) fail(error);
      }
      return true;
    },
  };
}
